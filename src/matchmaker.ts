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
    return rankings.getIds()
        .map(id => ({ address: id as Address, score: rankings.getScore(id) }))
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
    matchesPerPlayerPerBracket: number[];
} & (
        { players: string[]; rankings?: never; } |
        { rankings: PlayerRankings; players?: never; }
    );

export class MatchMaker {
    protected readonly _prng: Prng;
    protected readonly _rankings: PlayerRankings;
    protected readonly _matchesPerPlayerPerBracket: number[];
    protected _bracketIdx: number = 0;

    public constructor(cfg: MatchMakerConfig) {
        if (cfg.matchesPerPlayerPerBracket.length < 1) {
            throw new Error('Invalid matchmaker config');
        }
        this._matchesPerPlayerPerBracket = cfg.matchesPerPlayerPerBracket;
        this._prng = new Prng(cfg.seed);
        this._matchesPerPlayerPerBracket = cfg.matchesPerPlayerPerBracket;
        this._rankings = cfg.rankings ?? new PlayerRankings(cfg.players);
    }

    public get maxBrackets(): number {
        return this._matchesPerPlayerPerBracket.length;
    }

    public get bracketIdx(): number {
        return this._bracketIdx;
    }

    public getBracketMatches(): string[][] {
        if (this._bracketIdx >= this._matchesPerPlayerPerBracket.length) {
            return [];
        }
        const matches = [] as string[][];
        for (let i = 0; i < this._matchesPerPlayerPerBracket[this._bracketIdx]; ++i) {
            const playerIds = this._prng.shuffle(this.getBracketPlayers());
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
   
    public advanceBracket(): void {
        ++this._bracketIdx;
    }

    public getAllPlayers(): string[] {
        return this._rankings.getIds();
    }
    
    public getBracketPlayers(): string[] {
        const minPlayerPercentile = 1 / (2 ** this._bracketIdx);
        return this.getAllPlayers()
            .sort((a, b) => this._rankings.getScore(b) - this._rankings.getScore(a))
            .slice(0, Math.max(MATCH_SEATS, Math.ceil(this._rankings.playerCount * minPlayerPercentile)));
    }

    public rankMatchResult(orderedPlayers: string[]): void {
        this._rankings.rankMatchResult(orderedPlayers);
    }

    public isDone(): boolean {
        return this._bracketIdx >= this._matchesPerPlayerPerBracket.length;
    }

    public getScore(id: string): number {
        return this._rankings.getScore(id);
    }

    public getScores(): ScoredPlayer[] {
        return getScoresFromPlayerRankings(this._rankings);
    }
}