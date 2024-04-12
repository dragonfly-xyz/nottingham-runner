import {
    Hex,
    Address,
    keccak256,
    createPublicClient,
    http,
    Chain,
} from 'viem';
import { getSeasonKeys, getSeasonPlayers } from './contest.js';
import { MatchMaker, ScoredPlayer } from './matchmaker.js';
import { LocalMatchPool } from './pools/local-match-pool.js';
import { Logger, MatchPool } from './pools/match-pool.js';
import { decryptPlayerCode, deriveSeasonPublicKey } from './encrypt.js';
import { mainnet } from 'viem/chains';

export interface LocalPoolConfig {
    workerCount: number;
}

export interface RemotePoolConfig {
    // TODO
}

export interface TournamentConfig {
    szn: number;
    rpcUrl: string;
    contestAddress: Address;
    mode: MatchMakingMode;
    poolConfig: LocalPoolConfig | RemotePoolConfig;
    chain: Chain,
    logger?: Logger;
}

export interface PrivateTournamentConfig extends TournamentConfig {
    seasonPrivateKey: Hex;
}

const DEFAULT_LOGGER = (() => {}) as Logger;

const SCRIMMAGE_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [2, 3, 4],
};

const TOURNAMENT_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [3, 4, 6, 10],
};

export enum MatchMakingMode {
    Scrimmage = 'scrimmage',
    Tournament = 'tournament',
}

function isPrivateTournamentConfig(cfg: TournamentConfig | PrivateTournamentConfig)
    : cfg is PrivateTournamentConfig
{
    return typeof((cfg as any).szn) === 'number' && (cfg as any).seasonPrivateKey;
}

function isLocalPoolConfig(cfg: LocalPoolConfig | RemotePoolConfig): cfg is LocalPoolConfig {
    return (cfg as LocalPoolConfig).workerCount !== undefined;
}

async function createMatchPool(cfg?: unknown): Promise<MatchPool> {
    if (isLocalPoolConfig(cfg)) {
        return LocalMatchPool.create(cfg.workerCount);
    }
    throw new Error('unimplemented');
}

export async function runTournament(cfg: TournamentConfig | PrivateTournamentConfig)
    : Promise<ScoredPlayer[]>
{
    const client = createPublicClient({ chain: mainnet, transport: http(cfg.rpcUrl, { retryCount: 3 }) });
    const logger = cfg.logger ?? DEFAULT_LOGGER;

    const szn = cfg.szn;;
    let seasonPrivateKey: Hex;
    let seasonPublicKey: Hex;
    if (isPrivateTournamentConfig(cfg)) {
        seasonPrivateKey = cfg.seasonPrivateKey;
        seasonPublicKey = deriveSeasonPublicKey(seasonPrivateKey);
    } else {
        const keys = await getSeasonKeys(client, cfg.contestAddress, szn);
        if (!keys.privateKey) {
            throw new Error(`Season ${szn} has not been revealed yet and no key was provided.`);
        }
        seasonPrivateKey = keys.privateKey!;
        seasonPublicKey = keys.publicKey!;
    }
    const playerCodes = Object.assign({},
        ...Object.entries(await getSeasonPlayers(client, cfg.contestAddress, szn))
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
    const pool = await createMatchPool(cfg.poolConfig);
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
        const playersPerMatch = mm.getRoundMatches();
        logger('round_start', { round: mm.roundIdx, players: mm.getRoundPlayers() });
        for (const matchPlayers of playersPerMatch) {
            matchPromises.push((async () => {
                const matchId = crypto.randomUUID();
                logger('match_created', { matchId, players: matchPlayers });
                try {
                    const result = await pool.runMatch({
                        id: matchId,
                        seed,
                        players: Object.assign(
                            {},
                            ...matchPlayers.map(id => ({ bytecode: playerCodes[id] })),
                        ),
                        logger,
                    });
                    mm.rankMatchResult(
                        Object.keys(result.playerResults)
                        .sort((a, b) => result.playerResults[b].score - result.playerResults[a].score),
                    );
                } catch (err) {
                    logger('match_failed', { matchId });
                    console.error(`Match with players ${matchPlayers.join(', ')} failed: `, err.message);
                }
            })());
        }
        await Promise.all(matchPromises);
    }
    return mm.getScores();
}