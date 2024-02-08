import "dotenv";
import "colors";
import process from "process";
import yargs from "yargs";
import {
    zeroAddress,
    zeroHash,
    Hex,
    Address,
    createWalletClient,
    http,
    WalletClient,
    PublicClient,
    createPublicClient,
} from "viem";
import { zkSync } from "viem/chains";
import * as CONTEST_ABI from "../../abis/Contest.json";

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
        mode: argv.mode as ('tournament' | 'scrimmage'),
        seasonKeys: [],
    }),
).argv;


interface ScrimmageMatchMakerConfig {
    seed: string,
    targetConfidence: number;
    minMatchesPerPlayer: number;
    maxMatchesPerPlayer: number;
    db: PlayerDB;
    rankings?: PlayerRankings;
}

interface PlayerInfo {
    address: Address;
    bytecode: Hex;
}

class ScrimmageMatchMaker {
    private readonly _seed: string;
    private readonly _targetConfidence: number;
    private readonly _minMatchesPerPlayer: number;
    private readonly _maxMatchesPerPlayer: number;
    private readonly _db: PlayerDB;
    public readonly _rankings: PlayerRankings;

    public constructor(cfg: ScrimmageMatchMakerConfig) {
        this._seed = cfg.seed;
        this._targetConfidence = cfg.targetConfidence;
        this._minMatchesPerPlayer = cfg.minMatchesPerPlayer;
        this._db = cfg.db;
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.db);
    }

    public async getMatches(maxCount: number): Promise<PlayerInfo[][]> {
        // ...
        return [];
    }

    public isDone(): boolean {
        // ...
        return true;
    }
}


interface PlayerRankingInfo {
    address: Address;
    matchCount: number;
    mu: number;
    signam: number;
}

class PlayerRankings {
    public constructor(public readonly db: PlayerDB) {}

    public async reload(): Promise<this> {
        // ...
        return this;
    }
}

interface TournamentMatchMakerConfig extends ScrimmageMatchMakerConfig {
    eliteCount: number;
    eliteConfidence: number;
}

class TournamentMatchMaker {
    private readonly _seed: string;
    private readonly _eliteCount: number;
    private readonly _eliteConfidence: number;
    private readonly _db: PlayerDB;
    private readonly _scrimmageMM: ScrimmageMatchMaker;
    public readonly _rankings: PlayerRankings;

    public constructor(cfg: TournamentMatchMakerConfig) {
        this._seed = cfg.seed;
        this._eliteConfidence = cfg.eliteConfidence;
        this._eliteCount = cfg.eliteCount;
        this._db = cfg.db;
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.db);
        this._scrimmageMM = new ScrimmageMatchMaker(cfg);
    }

    public async getMatches(maxCount: number): Promise<PlayerInfo[][]> {
        // ...
        return [];
    }

    public isDone(): boolean {
        if (!this._scrimmageMM.isDone()) {
            return false;
        }
        // ...
        return true;
    }
}


interface SeasonInfo {
    idx: number;
    publicKey: string;
    privateKey: string;
}

class Contest {
    private _readClient: PublicClient; 
    private _wallet: WalletClient;

    public constructor(public readonly address: Address) {
        const transport = http(process.env.RPC_URL, { retryCount: 2 });
        this._readClient = createPublicClient({ transport });
        this._wallet = createWalletClient({
            key: process.env.PRIVATE_KEY || zeroHash,
            transport,
            chain: zkSync,
        });
    }

    public async getSeasonInfo(seasonIdx: number): Promise<SeasonInfo> {
        return {
            idx: seasonIdx,
            publicKey: zeroHash, 
            privateKey: zeroHash,
        };
    }

    public async getCurrentSeasonInfo(): Promise<SeasonInfo> {
        const seasonIdx = await this.getCurrentSeasonIdx();
        return this.getSeasonInfo(seasonIdx);
    }

    public async getCurrentSeasonIdx(): Promise<number> {
        return Number(await this._readClient.readContract({
            abi: CONTEST_ABI,
            address: this.address,
            functionName: 'currentSeasonIdx',
        }) as bigint);
    }

    public async beginNewSeason(seasonIdx: number, topPlayer: Address, publicKey: Hex): Promise<number> {
        // ...
        return seasonIdx;
    }
}

class PlayerDB {
    public static async load(contest: Contest): Promise<PlayerDB> {
        // ...
        return new PlayerDB();
    }
}

interface TournamentConfig {
    address: Address;
    seasonKeys: Hex[];
    mode: 'tournament' | 'scrimmage';
}

async function playMatch(
    season: SeasonInfo,
    db: PlayerDB,
    players: PlayerInfo[],
): Promise<Address[]> {
    // ...
    return [];
}

async function rankPlayers(db: PlayerDB, matchResults: Address[][]): Promise<void> {
    // ...
}

async function runTournament(cfg: TournamentConfig) {
    const contest = new Contest(cfg.address);
    const season  = await contest.getCurrentSeasonInfo();
    if (!season.privateKey) {
        throw new Error('Season still open.');
    }
    const db = await PlayerDB.load(contest);
    const mm = await MatchMaker.create({
        seed: season.privateKey,
        targetConfidence: 0.9,
        minMatchesPerPlayer: 10,
        maxMatchesPerPlayer: 100,
        minSeats: 3,
        maxSeats: 5,
        db,
    });
    while (!mm.isDone()) {
        const matches = await mm.getMatches(10);
        const matchResults = await Promise.all(
            matches.map(players => playMatch(season, db, players)),
        );
        console.log(matchResults);
        await rankPlayers(db, matchResults);
    }
    const nextSeasonIdx = season.idx + 1;
    await contest.beginNewSeason(
        nextSeasonIdx,
        await mm.getTopPlayer(),
        cfg.seasonKeys[nextSeasonIdx] ?? zeroHash,
    );
}