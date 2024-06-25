import {
    Hex,
    Address,
    keccak256,
    toBytes,
    toHex,
} from 'viem';
import { MatchMaker, ScoredPlayer } from './matchmaker.js';
import { Logger, MatchPool } from './pools/match-pool.js';
import { EncryptedCodeSubmission, decryptPlayerCode } from './encrypt.js';
import { MAX_CODE_SIZE } from './node.js';

export interface PlayerCodes {
    [name: string]: Hex;
}

export interface TournamentConfig {
    matchPool: MatchPool,
    logger?: Logger;
    matchTimeout?: number;
    tolerant?: boolean;
    brackets: number[];
    players: PlayerCodes;
    matchSeats: number;
    seed?: string;
}

const DEFAULT_LOGGER = (() => {}) as Logger;

export function augmentLogger(logger: Logger, extraData: object): Logger {
    return (name, data) => logger(name, { ...data, ...extraData });
}

export async function runTournament(cfg: TournamentConfig)
    : Promise<ScoredPlayer[]>
{
    const startTime = Date.now();
    const { players } = cfg;
    const logger = cfg.logger ?? DEFAULT_LOGGER;

    if (Object.keys(players).length === 0) {
        logger('tournament_aborted', {reason: 'no players' });
        return [];
    }
    
    logger('tournament_start', { players: Object.keys(players) });

    const seed = keccak256(Buffer.from(cfg.seed ?? crypto.randomUUID()));
    const mm: MatchMaker = new MatchMaker({
        seed,
        matchesPerPlayerPerBracket: cfg.brackets,
        players: Object.keys(players),
        matchSeats: cfg.matchSeats,
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
                                [id]: { bytecode: players[id] },
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
            scores: mm.getBracketPlayers().map(id => ({ name: id, score: mm.getScore(id) })),
        });
        mm.advanceBracket();
    }
    const scores = mm.getScores();
    logger('tournament_completed', { startTime, endTime: new Date(), scores });
    return scores;
}

export function decryptPlayerSubmission(opts: {
    player: Address;
    seasonPrivateKey: Hex;
    codeHash: Hex;
    submission: EncryptedCodeSubmission;
}): Hex {
    const code = decryptPlayerCode(
        opts.seasonPrivateKey,
        opts.player,
        opts.submission,
    );
    if (keccak256(code) !== opts.codeHash) {
        throw new Error(`Code hash does not match`);
    }
    return toHex(toBytes(code).slice(0, MAX_CODE_SIZE));
}