import "dotenv";
import "colors";
import process from "process";
import yargs from "yargs";
import {
    zeroHash,
    Hex,
    Address,
} from "viem";
import { Contest } from "./contest";
import { MatchMaker, ScrimmageMatchMaker, TournamentMatchMaker } from "./matchmakers";

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

async function playMatch(
    season: SeasonInfo,
    players: PlayerInfo[],
): Promise<string[]> {
    // ...
    return [];
}

const MIN_MATCH_SEATS = 3;
const MAX_MATCH_SEATS = 5;

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
        const matchPlayers = mm.getNextMatch();
        const matchResults = await playMatch(
            season,
            Object.assign(
                {},
                ...matchPlayers.map(p => ({ [p]: playerCodes[p] })),
            ),
        );
        console.log(matchResults);
        mm.rankMatchResults(matchResults);
    }
    const nextSeasonIdx = season.idx + 1;
    await contest.beginNewSeason(
        nextSeasonIdx,
        mm.getScores()[0].address,
        cfg.seasonKeys[nextSeasonIdx] ?? zeroHash,
    );
}