import { Prng } from "./prng.js";

export interface ScoredPlayer {
    name: string;
    score: number;
}

interface PlayerScoreInternals {
    normalizedPlaceSum: number;
    matchCount: number;
}

const EMPTY_PLAYER_SCORE_INTERNALS: PlayerScoreInternals = {
    normalizedPlaceSum: 0,
    matchCount: 0,
};

export type MatchMakerConfig = {
    seed: string;
    matchesPerPlayerPerBracket: number[];
    players: string[];
    matchSeats: number;
}

export class MatchMaker {
    protected readonly _prng: Prng;
    protected readonly _ids: string[];
    protected readonly _matchesPerPlayerPerBracket: number[];
    protected readonly _matchSeats: number;
    protected _bracketIdx: number = 0;
    protected _scoresByBracketById: Array<{ [id: string]: PlayerScoreInternals }> = [];

    public constructor(cfg: MatchMakerConfig) {
        if (cfg.matchesPerPlayerPerBracket.length < 1) {
            throw new Error('Invalid matchmaker config');
        }
        this._matchesPerPlayerPerBracket = cfg.matchesPerPlayerPerBracket;
        this._prng = new Prng(cfg.seed);
        this._matchesPerPlayerPerBracket = cfg.matchesPerPlayerPerBracket;
        this._ids = cfg.players.slice();
        this._matchSeats = cfg.matchSeats;
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
            const playerIds = this._prng.shuffle(this.getBracketPlayers(this._bracketIdx));
            if (playerIds.length < this._matchSeats) {
                throw new Error(`not enough players for a full match: ${
                    playerIds.length}/${this._matchSeats}`);
            }
            const matchCount = Math.ceil(playerIds.length / this._matchSeats);
            for (let j = 0; j < matchCount; ++j) {
                const matchPlayers = [] as string[];
                for (let k = 0; k < this._matchSeats; ++k) {
                    matchPlayers.push(playerIds[(j * this._matchSeats + k) % playerIds.length]);
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
        return this._ids.slice();
    }
    
    public getBracketPlayers(bracketIdx?: number): string[] {
        bracketIdx = bracketIdx ?? this._bracketIdx;
        const minPlayerPercentile = 1 / (2 ** bracketIdx);
        const scoresById = Object.assign({},
            ...this._ids.map(id => ({ [id]: this.getScore(id, bracketIdx) })),
        );
        const sortedIds = this._ids.slice().sort((a, b) => scoresById[b] - scoresById[a]);
        return sortedIds.slice(
            0,
            Math.max(Math.ceil(this._matchSeats * 1.5), Math.ceil(sortedIds.length * minPlayerPercentile)),
        );
    }

    public rankMatchResult(orderedPlayers: string[]): void {
        const ranks = this._scoresByBracketById[this._bracketIdx] = 
            this._scoresByBracketById[this._bracketIdx] ?? {};
        for (let i = 0; i < orderedPlayers.length; ++i) {
            const p = orderedPlayers[i];
            const r = ranks[p] = ranks[p] ?? { ...EMPTY_PLAYER_SCORE_INTERNALS };
            if (orderedPlayers.length > 1) {
                r.matchCount++;
                r.normalizedPlaceSum += 1 - i / orderedPlayers.length;
            }
        }
    }

    public isDone(): boolean {
        return this._bracketIdx >= this._matchesPerPlayerPerBracket.length;
    }

    public getScore(id: string, bracketIdx?: number): number {
        bracketIdx = bracketIdx ?? this._bracketIdx;
        let score = 0;
        for (let i = 0; i < bracketIdx + 1; ++i) {
            const s = this._scoresByBracketById[i]?.[id];
            if (s?.matchCount) {
                score += (i+1) * ((s?.normalizedPlaceSum ?? 0) / s.matchCount);
            }
        }
        return score;
    }

    public getScores(): ScoredPlayer[] {
        return this._ids.map(id => ({
            name: id as string,
            score: this.getScore(id),
        })).sort((a, b) => b.score - a.score);
    }
}