import { Address } from "viem";
import { Prng } from "./prng.js";
import * as oskill from "openskill";
import { ordinal } from "openskill";

export interface ScoredPlayer {
    address: Address;
    score: number;
}

interface PlayerRankingInfo {
    mu: number;
    sigma: number;
}

const EMPTY_PLAYER_RANKING_INFO: PlayerRankingInfo = {
    ...oskill.rating(),
};

export const MATCH_SEATS = 4;

function getScoresFromPlayerRankings(rankings: PlayerRankings): ScoredPlayer[] {
    return Object.entries(rankings)
        .map(([id, info]) => ({ address: id as Address, score: oskill.ordinal(info) }))
        .sort((a, b) => b.score - a.score);
}

export class PlayerRankings {
    protected readonly _ids: string[];
    protected _scoresById: { [id: string]: PlayerRankingInfo };
    
    public constructor(ids: string[]) {
        this._ids = ids.slice();
        this._scoresById = Object.assign(
            {},
            ...ids.map(id => ({ [id]: {... EMPTY_PLAYER_RANKING_INFO } })),
        );
    }

    public isId(id: string): boolean {
        return id in this._scoresById;
    }
    
    public get playerCount(): number {
        return this._ids.length;
    }

    public getConfidence(id: string): number {
        return Math.max(0, Math.min(1,
            1 - this._scoresById[id].sigma / EMPTY_PLAYER_RANKING_INFO.sigma
        ));
    }

    public getScore(id: string): number {
        return ordinal(this._scoresById[id]);
    }

    public getIds(): string[] {
        return this._ids.slice();
    }

    public rankMatchResult(ids: string[]): void {
        const infos = ids.map(id => this._scoresById[id]);
        if (!infos.every(info => !!info)) {
            throw new Error('Player ID not found in rankings');
        }
        const changes = oskill.rate(infos.map(i => [{ sigma: i.sigma, mu: i.mu }])).flat(1);
        for (let i = 0; i < infos.length; ++i) {
            infos[i].mu = changes[i].mu;
            infos[i].sigma = changes[i].sigma;
        }
    }
}

export type MatchMakerConfig = {
    seed: string;
    matchesPerPlayerPerRound: number[];
} & (
        { players: string[]; rankings?: never; } |
        { rankings: PlayerRankings; players?: never; }
    );

export class MatchMaker {
    protected readonly _prng: Prng;
    protected readonly _rankings: PlayerRankings;
    protected readonly _matchesPerPlayerPerRound: number[];
    protected _roundIdx: number = 0;

    public constructor(cfg: MatchMakerConfig) {
        if (cfg.matchesPerPlayerPerRound.length < 1) {
            throw new Error('Invalid matchmaker config');
        }
        this._matchesPerPlayerPerRound = cfg.matchesPerPlayerPerRound;
        this._prng = new Prng(cfg.seed);
        this._matchesPerPlayerPerRound = cfg.matchesPerPlayerPerRound;
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.players);
    }

    public get maxRounds(): number {
        return this._matchesPerPlayerPerRound.length;
    }

    public get roundIdx(): number {
        return this._roundIdx;
    }

    public getRoundMatches(): string[][] {
        if (this._roundIdx >= this._matchesPerPlayerPerRound.length) {
            return [];
        }
        const matches = [] as string[][];
        for (let i = 0; i < this._matchesPerPlayerPerRound[this._roundIdx]; ++i) {
            const playerIds = this._prng.shuffle(this.getRoundPlayers());
            if (playerIds.length < MATCH_SEATS) {
                throw new Error(`not enough players for a full match: ${playerIds.length}/${MATCH_SEATS}`);
            }
            const matchCount = Math.ceil(playerIds.length / MATCH_SEATS);
            for (let j = 0; j < matchCount; ++j) {
                const matchPlayers = [] as string[];
                for (let k = 0; k < MATCH_SEATS; ++k) {
                    matchPlayers.push(playerIds[(j * MATCH_SEATS + k) % playerIds.length]);
                }
                matches.push(matchPlayers);
            }
        }
        return matches;
    }
   
    public advanceRound(): void {
        ++this._roundIdx;
    }

    public getAllPlayers(): string[] {
        return this._rankings.getIds();
    }
    
    public getRoundPlayers(): string[] {
        const minPlayerPercentile = 1 / (2 ** this._roundIdx);
        return this.getAllPlayers()
            .sort((a, b) => this._rankings.getScore(b) - this._rankings.getScore(a))
            .slice(0, Math.max(MATCH_SEATS, Math.ceil(this._rankings.playerCount * minPlayerPercentile)));
    }

    public rankMatchResult(orderedPlayers: string[]): void {
        this._rankings.rankMatchResult(orderedPlayers);
    }

    public isDone(): boolean {
        return this._roundIdx >= this._matchesPerPlayerPerRound.length;
    }

    public getScore(id: string): number {
        return this._rankings.getScore(id);
    }

    public getScores(): ScoredPlayer[] {
        return getScoresFromPlayerRankings(this._rankings);
    }
}