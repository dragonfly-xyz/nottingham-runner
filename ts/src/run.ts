import "dotenv";
import "colors";
import process from "process";
import yargs from "yargs";
import {
    zeroHash,
    Hex,
    Address,
    keccak256,
} from "viem";
import { Contest, SeasonInfo } from "./contest.js";
import { MatchMaker } from "./matchmakers.js";
import { LocalMatchPool } from './pools/local-match-pool.js';
import { MatchPool } from "./pools/match-pool.js";

yargs(process.argv.slice(0)).command(
    '$0', 'run a tournament on the current (closed) season',
    yargs => yargs
        .option('address', {
            alias: 'a',
            type: 'string',
            demandOption: true,
            desc: 'contest contract address',
            coerce: arg => arg as Hex,
        })
        .option('season', { alias: 's', type: 'number', desc: 'override season index' })
        .option('mode', { alias: 'm', type: 'string', choices: ['tournament', 'scrimmage'], default: 'tournament' })
    ,
    async argv => runTournament({
        address: argv.address,
        mode: argv.mode == 'tournament' ? MatchMakingMode.Tournament : MatchMakingMode.Scrimmage,
        seasonKeys: [],
        poolConfig: { workerCount: 4 },
    }),
).argv;

interface LocalPoolConfig {
    workerCount: number;
}

interface RemotePoolConfig {
    // TODO
}

interface TournamentConfig {
    address: Address;
    seasonKeys: Hex[];
    mode: MatchMakingMode;
    poolConfig: LocalPoolConfig | RemotePoolConfig;
}

const SCRIMMAGE_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [2, 3, 4],
};

const TOURNAMENT_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [3, 4, 6, 10],
};

enum MatchMakingMode {
    Scrimmage = 'scrimmage',
    Tournament = 'tournament',
}

async function runTournament(cfg: TournamentConfig) {
    const contest = new Contest(cfg.address);
    const season  = await contest.getCurrentSeasonInfo();
    if (!season.publicKey) {
        throw new Error('Season hasn\'t started.');
    }
    if (cfg.mode === MatchMakingMode.Tournament) {
        if (!season.privateKey) {
            throw new Error('Season still active.');
        }
    }
    const seed = keccak256(Buffer.from(season.publicKey));
    const playerCodes = await contest.getActivePlayersForSeason(season);
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
        let matchCount = 0;
        let matchPromises = [] as Array<Promise<any>>;
        const playersPerMatch = mm.getRoundMatches();
        for (const matchPlayers of playersPerMatch) {
            ++matchCount;
            matchPromises.push((async () => {
                try {
                    const result = await pool.runMatch({
                        seed,
                        players: Object.assign(
                            {},
                            ...matchPlayers.map(id => ({ bytecode: playerCodes[id] })),
                        ),
                    });
                    mm.rankMatchResult(
                        Object.keys(result.playerResults)
                        .sort((a, b) => result.playerResults[b].score - result.playerResults[a].score),
                    );
                } catch (err) {
                    console.error(`Match with players ${matchPlayers.join(', ')} failed: `, err.message);
                } finally {
                    --matchCount;
                }
            })());
        }
        while (matchCount > 0) {
            await Promise.race(matchPromises);
            console.info(`Matches left: ${matchCount}...`);
        }
    }
    const nextSeasonIdx = season.idx + 1;
    await contest.beginNewSeason(
        nextSeasonIdx,
        mm.getScores()[0].address,
        cfg.seasonKeys[nextSeasonIdx] ?? zeroHash,
    );
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