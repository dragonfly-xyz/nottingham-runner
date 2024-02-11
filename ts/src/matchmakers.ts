import { Address } from "viem";
import { Prng } from "./prng";

export interface ScoredPlayer {
    address: Address;
    score: number;
}

export interface MatchMaker {
    isDone(): boolean;
    getNextMatch(): string[];
    getScores(): ScoredPlayer[];
    rankMatchResults(orderedPlayers: string[]): void;
}

interface PlayerRankingInfo {
    matchCount: number;
    mu: number;
    sigma: number;
}

interface PlayerRankings {
    [id: string]: PlayerRankingInfo;
}

const EMPTY_PLAYER_RANKING_INFO: PlayerRankingInfo = {
    matchCount: 0,
    mu: 0,
    sigma: Number.POSITIVE_INFINITY,
};

const MIN_MATCH_SEATS = 3;
const MAX_MATCH_SEATS = 5;

function createEmptyPlayerRankings(players: string[]): PlayerRankings {
    return Object.assign(
        {},
        ...players.map(id => ({ [id]: { ...EMPTY_PLAYER_RANKING_INFO } })),
    );
}

function getScoresFromPlayerRankings(rankings: PlayerRankings): ScoredPlayer[] {
    return Object.entries(rankings)
        .map(([id, info]) => ({ address: id as Address, score: info.mu }))
        .sort((a, b) => b.score - a.score);
}

export type ScrimmageMatchMakerConfig = {
    seed: string;
    targetConfidence: number;
    minMatchesPerPlayer: number;
    maxMatchesPerPlayer: number;
} & (
        { players: string[]; rankings?: never; } |
        { rankings: PlayerRankings; players?: never; }
    );

export class ScrimmageMatchMaker implements MatchMaker {
    private readonly _prng: Prng;
    private readonly _targetConfidence: number;
    private readonly _minMatchesPerPlayer: number;
    private readonly _maxMatchesPerPlayer: number;
    private readonly _rankings: PlayerRankings;

    public constructor(cfg: ScrimmageMatchMakerConfig) {
        if (cfg.maxMatchesPerPlayer < cfg.minMatchesPerPlayer ||
            cfg.targetConfidence > 1 ||
            cfg.targetConfidence < 0
        ) {
            throw new Error('Invalid matchmaker config');
        }
        this._prng = new Prng(cfg.seed);
        this._targetConfidence = cfg.targetConfidence;
        this._minMatchesPerPlayer = cfg.minMatchesPerPlayer;
        this._rankings = cfg.rankings ?? createEmptyPlayerRankings(cfg.players);
    }

    public getNextMatch(): string[] {
        const playerIds = Object.keys(this._rankings)
            .filter(id =>
                this._rankings[id].matchCount < this._maxMatchesPerPlayer &&
                this._rankings[id].sigma < this._targetConfidence
            );
        const playerIds = this._getPlayerPool();
        const playerWeights = playerIds.map(id => this._rankings[id].sigma);
        return this._prng.sampleWeighted(playerWeights, Math.min())
        return [];
    }

    private _getPlayerPool(): string[] {
        const playerIds = Object.keys(this._rankings)
            .filter(id =>
                this._rankings[id].matchCount < this._maxMatchesPerPlayer &&
                this._rankings[id].sigma < this._targetConfidence
            );
        if (playerIds)
    }

    public rankMatchResults(orderedPlayers: string[]): void {
        // ...
    }

    public isDone(): boolean {
        // ...
        return true;
    }

    public getScores(): ScoredPlayer[] {
        return getScoresFromPlayerRankings(this._rankings);
    }
}

export type TournamentMatchMakerConfig = ScrimmageMatchMakerConfig & {
    eliteCount: number;
    eliteConfidence: number;
}

export class TournamentMatchMaker implements MatchMaker {
    private readonly _prng: Prng;
    private readonly _eliteCount: number;
    private readonly _eliteConfidence: number;
    private readonly _scrimmage: ScrimmageMatchMaker;
    private readonly _rankings: PlayerRankings;

    public constructor(cfg: TournamentMatchMakerConfig) {
        if (cfg.eliteConfidence > 1 || cfg.eliteConfidence < 0) {
            throw new Error('Invalid matchmaker config');
        }
        this._prng = new Prng(cfg.seed);
        this._eliteConfidence = cfg.eliteConfidence;
        this._eliteCount = cfg.eliteCount;
        this._rankings = cfg.rankings ?? createEmptyPlayerRankings(cfg.players);
        this._scrimmage = new ScrimmageMatchMaker(cfg);
    }

    public getNextMatch(): string[] {
        // ...
        return [];
    }

    public rankMatchResults(orderedPlayers: string[]): void {
        // ...
    }

    public isDone(): boolean {
        if (!this._scrimmage.isDone()) {
            return false;
        }
        // ...
        return true;
    }

    public getScores(): ScoredPlayer[] {
        return getScoresFromPlayerRankings(this._rankings);
    }
}
