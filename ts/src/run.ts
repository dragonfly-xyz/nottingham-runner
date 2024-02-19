import "dotenv";
import "colors";
import process from "process";
import yargs from "yargs";
import {
    zeroHash,
    Hex,
    Address,
} from "viem";
import { Contest } from "./contest.js";
import { MatchMaker, ScrimmageMatchMaker, TournamentMatchMaker } from "./matchmakers.js";
import { NodeCluster } from "./node-cluster.js";
import { MatchJob, PlayerScore } from "./match.js";

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
    }),
).argv;

interface TournamentConfig {
    address: Address;
    seasonKeys: Hex[];
    mode: MatchMakingMode;
}

const SCRIMMAGE_MATCHMAKER_CONFIG = {
    targetConfidence: 0.66,
    minMatchesPerPlayer: 10,
    maxMatchesPerPlayer: 20,
};

const TOURNAMENT_MATCHMAKER_CONFIG = {
    targetConfidence: 0.75,
    minMatchesPerPlayer: 10,
    maxMatchesPerPlayer: 40,
    eliteConfidence: 0.95,
    eliteCount: 10,
};

enum MatchMakingMode {
    Scrimmage = 'scrimmage',
    Tournament = 'tournament',
}

async function runTournament(cfg: TournamentConfig) {
    const contest = new Contest(cfg.address);
    const season  = await contest.getCurrentSeasonInfo();
    if (!season.privateKey) {
        throw new Error('Season still open.');
    }
    const playerCodes = await contest.getActivePlayersForSeason(season);
    const cluster = await NodeCluster.create();
    let mm: MatchMaker;
    if (cfg.mode == MatchMakingMode.Tournament) {
        mm = new TournamentMatchMaker({
            ...TOURNAMENT_MATCHMAKER_CONFIG,
            seed: season.privateKey,
            players: Object.keys(playerCodes),
        });
    } else {
        mm = new ScrimmageMatchMaker({
            ...SCRIMMAGE_MATCHMAKER_CONFIG,
            seed: season.privateKey,
            players: Object.keys(playerCodes),
        })
    }
    while (!mm.isDone()) {
        const matchResults = [] as Array<PlayerScore[]>;
        const matchPromises = [] as Array<Promise<PlayerScore[]>>;
        while (cluster.queueSize < 10) {
            const matchPlayers = mm.getNextMatch();
            if (matchPlayers.length === 0) {
                break;
            }
            const p = cluster.run(new MatchJob(
                season.privateKey,
                matchPlayers.map(id => ({ id, bytecode: playerCodes[id] })),
            ));
            p.then(r => {
                matchPromises.splice(matchPromises.indexOf(p), 1);
                matchResults.push(r);
            }).catch(err => console.warn(`Match with ${matchPlayers} failed: ${err}`));
            matchPromises.push(p);
        }
        try {
            await Promise.race(matchPromises);
        } catch (err) {
            console.warn(err);
        }
        if (matchResults.length === 5 || cluster.queueSize === 0) {
            for (const r of matchResults) {
                mm.rankMatchResult(r.map(s => s.id));
            }
            matchResults.splice(0, matchResults.length);
        }
    }
    const nextSeasonIdx = season.idx + 1;
    await contest.beginNewSeason(
        nextSeasonIdx,
        mm.getScores()[0].address,
        cfg.seasonKeys[nextSeasonIdx] ?? zeroHash,
    );
}