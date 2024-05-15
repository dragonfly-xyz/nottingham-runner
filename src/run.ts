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

export interface PlayerCodes {
    [address: Address]: Hex;
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
    brackets?: number[];
    whitelist?: Address[];
}

export interface PrivateTournamentConfig extends TournamentConfig {
    seasonPrivateKey: Hex;
}

export interface ExplicitTournamentConfig extends TournamentConfig {
    playerCodes: PlayerCodes;
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

type RunTournamentConfig = TournamentConfig | PrivateTournamentConfig | ExplicitTournamentConfig;

function isPrivateTournamentConfig(cfg: RunTournamentConfig)
    : cfg is PrivateTournamentConfig
{
    return !!(cfg as any).seasonPrivateKey;
}

function isExplicitTournamentConfig(cfg: RunTournamentConfig)
    : cfg is ExplicitTournamentConfig
{
    return !!(cfg as any).playerCodes;
}

export async function runTournament(cfg: RunTournamentConfig)
    : Promise<ScoredPlayer[]>
{
    const { szn, contestAddress, client } = cfg;
    const logger = cfg.logger ?? DEFAULT_LOGGER;
    let seasonPrivateKey: Hex;
    let seasonPublicKey: Hex;
    let playerCodes: PlayerCodes = {};

    if (isExplicitTournamentConfig(cfg)) {
        playerCodes = cfg.playerCodes;
    } else {
        if (isPrivateTournamentConfig(cfg)) {
            seasonPrivateKey = cfg.seasonPrivateKey;
            seasonPublicKey = deriveSeasonPublicKey(seasonPrivateKey);
        } else {
            const keys = await getSeasonKeys(client, contestAddress, szn);
            if (!keys.privateKey) {
                throw new Error(`Season ${szn} has not been revealed yet and no key was provided.`);
            }
            seasonPrivateKey = keys.privateKey!;
            seasonPublicKey = keys.publicKey!;
        }
        playerCodes = await getDecryptedPlayerCodes({
            client,
            contestAddress,
            logger,
            seasonPrivateKey,
            szn,
            whitelist: cfg.whitelist,
        });
    }

    if (Object.keys(playerCodes).length === 0) {
        logger('tournament_cancelled', {reason: 'no players' });
        return [];
    }
    
    logger('tournament_start', { players: Object.keys(playerCodes) });

    const seed = keccak256(Buffer.from(seasonPublicKey ?? ''));
    const mm: MatchMaker = new MatchMaker({
        ...(cfg.mode === MatchMakingMode.Tournament
                ? TOURNAMENT_MATCHMAKER_CONFIG
                : SCRIMMAGE_MATCHMAKER_CONFIG
            ),
        ...(cfg.brackets ? { matchesPerPlayerPerBracket: cfg.brackets } : {}),
        seed,
        players: Object.keys(playerCodes),
    });
    while (!mm.isDone()) {
        let matchPromises = [] as Array<Promise<any>>;
        const playersPerMatch = mm.getBracketMatches();
        const bracket = mm.bracketIdx;
        logger('bracket_start', { bracket, players: mm.getBracketPlayers() });
        for (const matchPlayers of playersPerMatch) {
            matchPromises.push((async () => {
                const matchId = crypto.randomUUID();
                logger('match_created', { matchId, players: matchPlayers, bracket });
                let startTime = Date.now();
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
                        bracket,
                        scores: matchPlayers.map(p => result.playerResults[p].score),
                        gasUsed: matchPlayers.map(p => result.playerResults[p].gasUsed),
                        duration: Math.round((Date.now() - startTime) / 1e3),
                    });
                } catch (err) {
                    logger('match_failed', {
                        matchId,
                        error: err.message,
                        bracket,
                        duration: Math.round((Date.now() - startTime) / 1e3),
                    });
                    console.error(`Match with players ${matchPlayers.join(', ')} failed: `, err.message);
                    if (!cfg.tolerant) {
                        throw err;
                    }
                }
            })());
        }
        await Promise.all(matchPromises);
        logger('bracket_completed', {
            bracket,
            rankings: Object.assign({},
                ...mm.getBracketPlayers().map(id => ({ [id]: mm.getScore(id) })),
            ),
        });
        mm.advanceBracket();
    }
    return mm.getScores();
}

async function getDecryptedPlayerCodes(opts: {
    client: PublicClient;
    contestAddress: Address;
    szn: number;
    seasonPrivateKey: Hex;
    logger: Logger;
    whitelist?: Address[],
}): Promise<PlayerCodes> {
    const whitelistMap = opts.whitelist
        ? Object.assign({}, ...(opts.whitelist.map(a => ({ [a.toLowerCase()]: true }))))
        : null;
    const { client, contestAddress, szn, seasonPrivateKey, logger } = opts;
    return Object.assign({},
        ...Object.entries(await getSeasonPlayers(client, contestAddress, szn))
            .filter(([id]) => !whitelistMap || id.toLowerCase() in whitelistMap)
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
                    logger('player_submission_error', {
                        player: id,
                        season: szn,
                    });
                    console.warn(`Failed to decrypt submission from ${id}:`, err);
                    return {};
                }
                return { [id as Address]: code };
            }),
    );
}
