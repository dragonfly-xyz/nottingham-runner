import {
    Hex,
    Address,
    keccak256,
    PublicClient,
} from 'viem';
import { getSeasonKeys, getSeasonPlayers } from './contest.js';
import { MatchMaker, ScoredPlayer } from './matchmaker.js';
import { Logger, MatchPool } from './pools/match-pool.js';
import { decryptPlayerCode, deriveSeasonPublicKey } from './encrypt.js';

export interface LocalPoolConfig {
    workerCount: number;
}

export interface TournamentConfig {
    szn: number;
    contestAddress: Address;
    mode: MatchMakingMode;
    matchPool: MatchPool,
    client: PublicClient,
    logger?: Logger;
    matchTimeout?: number;
    tolerant?: boolean;
}

export interface PrivateTournamentConfig extends TournamentConfig {
    seasonPrivateKey: Hex;
}

const DEFAULT_LOGGER = (() => {}) as Logger;

const SCRIMMAGE_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerBracket: [3, 4, 5],
};

const TOURNAMENT_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerBracket: [3, 4, 6, 10],
};

export enum MatchMakingMode {
    Scrimmage = 'scrimmage',
    Tournament = 'tournament',
}

function isPrivateTournamentConfig(cfg: TournamentConfig | PrivateTournamentConfig)
    : cfg is PrivateTournamentConfig
{
    return !!(cfg as any).seasonPrivateKey;
}

export async function runTournament(cfg: TournamentConfig | PrivateTournamentConfig)
    : Promise<ScoredPlayer[]>
{
   const logger = cfg.logger ?? DEFAULT_LOGGER;

    const szn = cfg.szn;;
    let seasonPrivateKey: Hex;
    let seasonPublicKey: Hex;
    if (isPrivateTournamentConfig(cfg)) {
        seasonPrivateKey = cfg.seasonPrivateKey;
        seasonPublicKey = deriveSeasonPublicKey(seasonPrivateKey);
    } else {
        const keys = await getSeasonKeys(cfg.client, cfg.contestAddress, szn);
        if (!keys.privateKey) {
            throw new Error(`Season ${szn} has not been revealed yet and no key was provided.`);
        }
        seasonPrivateKey = keys.privateKey!;
        seasonPublicKey = keys.publicKey!;
    }
    const playerCodes: { [id: Address]: Hex } = Object.assign({},
        ...Object.entries(await getSeasonPlayers(cfg.client, cfg.contestAddress, szn))
            .map(([id, { codeHash, encryptedAesKey, encryptedCode, iv }]) => {
                let code: Hex;
                try {
                    code = decryptPlayerCode(
                        seasonPrivateKey,
                        id as Hex,
                        { encryptedAesKey, encryptedCode, iv },
                    );
                    if (keccak256(code) !== codeHash) {
                        throw new Error(`Code hash does not match decrypted submission.`);
                    }
                } catch (err) {
                    logger('player_submission_error', { player: id });
                    console.warn(`Failed to decrypt submission from ${id}:`, err);
                    return {};
                }
                return { [id as Address]: code };
            }),
        );
    if (Object.keys(playerCodes).length === 0) {
        logger('tournament_cancelled', {mode: cfg.mode, season: szn, reason: 'no players' });
        return [];
    }
    
    logger('tournament_start', { mode: cfg.mode, season: szn, players: Object.keys(playerCodes) });

    const seed = keccak256(Buffer.from(seasonPublicKey));
    const mm: MatchMaker = new MatchMaker({
        ...(cfg.mode === MatchMakingMode.Tournament
                ? TOURNAMENT_MATCHMAKER_CONFIG
                : SCRIMMAGE_MATCHMAKER_CONFIG
            ),
        seed,
        players: Object.keys(playerCodes),
    });
    while (!mm.isDone()) {
        let matchPromises = [] as Array<Promise<any>>;
        const playersPerMatch = mm.getBracketMatches();
        const bracket = mm.bracketIdx;
        logger('bracket_start', { bracket: mm.bracketIdx, players: mm.getBracketPlayers() });
        for (const matchPlayers of playersPerMatch) {
            matchPromises.push((async () => {
                const matchId = crypto.randomUUID();
                logger('match_created', { matchId, players: matchPlayers });
                try {
                    const result = await cfg.matchPool.runMatch({
                        id: matchId,
                        seed,
                        players: Object.assign(
                            {},
                            ...matchPlayers.map(id => ({ [id]: { bytecode: playerCodes[id] } })),
                        ),
                        logger: (name, data) => logger(name, { ...data, matchId, bracket }),
                        timeout: cfg.matchTimeout,
                    });
                    mm.rankMatchResult(
                        Object.keys(result.playerResults)
                        .sort((a, b) => result.playerResults[b].score - result.playerResults[a].score),
                    );
                    logger('match_completed', {
                        matchId,
                        skill_scores: Object.assign({}, ...matchPlayers.map(p => ({ [p]: mm.getScore(p) }))),
                    });
                } catch (err) {
                    logger('match_failed', { matchId, error: err.message });
                    console.error(`Match with players ${matchPlayers.join(', ')} failed: `, err.message);
                    if (!cfg.tolerant) {
                        throw err;
                    }
                }
            })());
        }
        await Promise.all(matchPromises);
        logger('bracket_completed', { bracket: mm.bracketIdx });
        mm.advanceBracket();
    }
    return mm.getScores();
}