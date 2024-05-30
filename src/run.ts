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
    matchSeats?: number;
    seasonStartBlock?: number;
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

export function augmentLogger(logger: Logger, extraData: object): Logger {
    return (name, data) => logger(name, { ...data, ...extraData });
}

export async function runTournament(cfg: RunTournamentConfig)
    : Promise<ScoredPlayer[]>
{
    const startTime = Date.now();
    const { szn, contestAddress, client } = cfg;
    const logger = augmentLogger(cfg.logger ?? DEFAULT_LOGGER, { season: szn });
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
            seasonStartBlock: cfg.seasonStartBlock,
            whitelist: cfg.whitelist,
        });
    }

    if (Object.keys(playerCodes).length === 0) {
        logger('tournament_aborted', {reason: 'no players' });
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
        matchSeats: cfg.matchSeats ?? 3,
    });
    while (!mm.isDone()) {
        let matchPromises = [] as Array<Promise<any>>;
        const bracketStartTime = Date.now();
        const playersPerMatch = mm.getBracketMatches();
        const bracket = mm.bracketIdx;
        const bracketLogger = augmentLogger(logger, { bracket } );
        bracketLogger('bracket_start', { players: mm.getBracketPlayers() });
        for (const matchPlayers of playersPerMatch) {
            const matchId = crypto.randomUUID();
            const matchLogger = augmentLogger(bracketLogger, { matchId, bracket });
            matchPromises.push((async () => {
                matchLogger('match_created', { matchId, players: matchPlayers, bracket });
                // Will be replaced on game_start log.
                let matchStartTime = Date.now();
                try {
                    const result = await cfg.matchPool.runMatch({
                        id: matchId,
                        seed,
                        players: Object.assign(
                            {},
                            ...matchPlayers.map(id => ({
                                [id]: { bytecode: playerCodes[id] },
                            })),
                        ),
                        timeout: cfg.matchTimeout,
                        logger: (name, data) => {
                            if (name === 'game_start') {
                                matchStartTime = data.startTime;
                            }
                            matchLogger(name, { log: data });
                        },
                    });
                    mm.rankMatchResult(
                        Object.keys(result.playerResults)
                           .sort((a, b) =>
                                result.playerResults[b].score -
                                result.playerResults[a].score
                            ),
                    );
                    matchLogger('match_completed', {
                        results: matchPlayers.map(p => ({
                                ...result.playerResults[p],
                                player: p,
                            })).sort((a, b) => b.score - a.score),
                        duration: Date.now() - matchStartTime,
                        roundsTaken: result.roundsTaken,
                    });
                } catch (err) {
                    matchLogger('match_failed', {
                        error: err.message,
                        duration: Date.now() - matchStartTime,
                    });
                    console.error(`Match with players ${
                        matchPlayers.join(', ')} failed: `,
                        err.message,
                    );
                    if (!cfg.tolerant) {
                        throw err;
                    }
                }
            })());
        }
        await Promise.all(matchPromises);
        bracketLogger('bracket_completed', {
            duration: Date.now() - bracketStartTime,
            scores: mm.getBracketPlayers().map(id => ({ address: id, score: mm.getScore(id) })),
        });
        mm.advanceBracket();
    }
    const scores = mm.getScores();
    logger('tournament_completed', { startTime, endTime: new Date(), scores });
    return scores;
}

async function getDecryptedPlayerCodes(opts: {
    client: PublicClient;
    contestAddress: Address;
    szn: number;
    seasonPrivateKey: Hex;
    seasonStartBlock?: number;
    logger: Logger;
    whitelist?: Address[],
}): Promise<PlayerCodes> {
    const whitelistMap = opts.whitelist
        ? Object.assign({}, ...(opts.whitelist.map(a => ({ [a.toLowerCase()]: true }))))
        : null;
    const { client, contestAddress, szn, seasonPrivateKey, logger } = opts;
    return Object.assign({},
        ...Object.entries(await getSeasonPlayers(client, contestAddress, szn, opts.seasonStartBlock))
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
