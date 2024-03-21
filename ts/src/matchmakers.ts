import { Address } from "viem";
import { Prng } from "./prng.js";
import oskill, { ordinal } from "openskill";

export interface ScoredPlayer {
    address: Address;
    score: number;
}

export interface MatchMaker {
    isDone(): boolean;
    getNextMatch(): string[];
    getScores(): ScoredPlayer[];
    rankMatchResult(orderedPlayers: string[]): void;
}

interface PlayerRankingInfo {
    matchCount: number;
    mu: number;
    sigma: number;
}

const EMPTY_PLAYER_RANKING_INFO: PlayerRankingInfo = {
    matchCount: 0,
    mu: 0,
    sigma: Number.POSITIVE_INFINITY,
};

const MIN_MATCH_SEATS = 3;
const MAX_MATCH_SEATS = 4;

function getScoresFromPlayerRankings(rankings: PlayerRankings): ScoredPlayer[] {
    return Object.entries(rankings)
        .map(([id, info]) => ({ address: id as Address, score: oskill.ordinal(info) }))
        .sort((a, b) => b.score - a.score);
}

class PlayerRankings {
    private readonly _ids: string[];
    private _scoresById: { [id: string]: PlayerRankingInfo };
    
    public constructor(ids: string[]) {
        this._ids = ids.slice().sort((a, b) => a.localeCompare(b));
        this._scoresById = Object.assign(
            {},
            ...ids.map(id => ({ [id]: {... EMPTY_PLAYER_RANKING_INFO } })),
        );
    }

    public isId(id: string): boolean {
        return id in this._scoresById;
    }

    public getConfidence(id: string): number {
        // TODO: range?
        return Math.max(1 - this._scoresById[id].sigma);
    }

    public getMatchCount(id: string): number {
        return this._scoresById[id].matchCount;
    }

    public getScore(id: string): number {
        return ordinal(this._scoresById[id]);
    }

    public get ids(): string[] {
        return this._ids;
    }

    public rankMatchResult(ids: string[]): void {
        const infos = ids.map(id => this._scoresById[id]);
        if (!infos.every(info => !!info)) {
            throw new Error('Player ID not found in rankings');
        }
        const changes = oskill.rate(infos.map(i => [{ sigma: i.sigma, mu: i.mu }])).flat(1);
        for (let i = 0; i < infos.length; ++i) {
            ++infos[i].matchCount;
            infos[i].mu = changes[i].mu;
            infos[i].sigma = changes[i].sigma;
        }
    }
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
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.players);
    }

    public getNextMatch(): string[] {
        const playerIds = this._getEligiblePlayers();
        if (playerIds.length === 0) {
            return [];
        }
        const playerWeights = playerIds
            // TODO: Find sigma upperbound or use logarithmic transformation.
            .map(id => Math.max(Math.min(this._rankings[id].sigma, 100), 0));
        return this._prng
            .sampleWeighted(playerWeights, Math.max(MAX_MATCH_SEATS))
            .map(idx => playerIds[idx]);
    }

    private _isEligible(id: string): boolean {
        let isEligible = false;
        const confidence = this._rankings.getConfidence(id);
        const matchCount = this._rankings.getMatchCount(id);
        if (confidence < this._targetConfidence || matchCount < this._minMatchesPerPlayer) {
            isEligible = true;
        } else if (confidence >= this._targetConfidence && matchCount < this._maxMatchesPerPlayer) {
            isEligible = true;
        }
        return isEligible;
    }

    private _getEligiblePlayers(): string[] {
        const eligible = [] as string[];
        const ineligbile = [] as string[];
        for (const id of this._rankings.ids) {
            if (this._isEligible(id)) {
                eligible.push(id);
            } else {
                ineligbile.push(id);
            }
        }
        // If below minimum, pad with ineligible players.
        if (eligible.length > 0 && eligible.length < MIN_MATCH_SEATS) {
            ineligbile.sort((a, b) =>
                this._rankings.getConfidence(b) - this._rankings.getConfidence(a),
            );
            eligible.push(...ineligbile.slice(0, MIN_MATCH_SEATS - eligible.length));
        }
        return eligible;
    }

    public rankMatchResult(orderedPlayers: string[]): void {
        this._rankings.rankMatchResult(orderedPlayers);
    }

    public isDone(): boolean {
        return this._getEligiblePlayers().length == 0;
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
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.players);
        this._scrimmage = new ScrimmageMatchMaker(cfg);
    }

    public getNextMatch(): string[] {
        // ...
        return [];
    }

    public rankMatchResult(orderedPlayers: string[]): void {
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
