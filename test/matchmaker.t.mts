import { expect } from 'chai';
import { PlayerRankings, MatchMaker, MatchMakerConfig, MATCH_SEATS } from '../src/matchmaker.js';
import erf from '@stdlib/math-base-special-erf';

function cdf(x: number, mean: number = 0.5, std: number = 1/3): number {
    return (1 - erf((mean - x) / (Math.sqrt(2) * std))) / 2;
}

class NormalPlayers {
    private readonly _playerDensities: { [id: string]: number };

    constructor(count: number, prefix: string = 'normal_player') {
        const spacing = 1 / count;
        this._playerDensities = Object.assign(
            {},
            ...[...new Array(count)].map((_, i) => ({
                [`${prefix}-${i}`]: cdf(spacing * i),
            })),
        );
    }

    public isPlayer(id: string): boolean {
        return id in this._playerDensities;
    }

    public get players(): string[] {
        return Object.keys(this._playerDensities);
    }

    public get playerCount(): number {
        return Object.keys(this._playerDensities).length;
    }

    public sortPlayers(ids: string[]): string[] {
        return ids.slice().sort((a, b) => this._playerDensities[b] - this._playerDensities[a]);
    }
}

function uniqueIds(ids: string[]): string[] {
    return Object.keys(Object.assign({}, ...ids.map(id => ({ [id]: true }))));
}

class TestMatchMaker extends MatchMaker {
    public constructor(cfg: MatchMakerConfig) {
        super(cfg);
    }

    public get rankings(): PlayerRankings {
        return this._rankings;
    }
}

class TestPlayerRankings extends PlayerRankings {
    public constructor(ids: string[]) {
        super(ids);
    }

    public getRawScore(id: string): { mu: number; sigma: number } {
        const { mu, sigma } = this._scoresById[id];
        return { mu, sigma };
    }

    public setRawScore(id: string, mu: number, sigma: number): void {
        this._scoresById[id].mu = mu;
        this._scoresById[id].mu = sigma;
    }
}

describe('matchmaker tests', () => {
    describe('scrimmage', () => {
        const DEFAULT_SCRIMMAGE_CFG = {
            matchesPerPlayerPerRound: [1, 2, 3],
            seed: '',
        };

        it('can generate matches', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                players: players.players,
            });
            let roundCount = 0;
            for (; !mm.isDone(); ++roundCount) {
                const playersPerMatch = mm.getRoundMatches();
                for (const match of playersPerMatch) {
                    expect(match.every(id => players.isPlayer(id))).to.be.true;
                    expect(uniqueIds(match).length).to.eq(match.length);
                }
                mm.advanceRound();
            }
            expect(roundCount).to.eq(DEFAULT_SCRIMMAGE_CFG.matchesPerPlayerPerRound.length);
            expect(mm.roundIdx).to.eq(roundCount);
        });

        it('generates N matches per player per round', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                players: players.players,
            });
            while (!mm.isDone()) {
                const playersPerMatch = mm.getRoundMatches();
                const roundPlayers = mm.getRoundPlayers();
                const playerMatchCount =
                    Object.assign({}, ...mm.getRoundPlayers().map(id => ({ [id]: 0 }))) as
                        { [id: string]: number };
                for (const match of playersPerMatch) {
                    expect(match.every(id => players.isPlayer(id)), 'all match ids are valid players').to.be.true;
                    expect(match.every(id => roundPlayers.includes(id)), 'all match ids are round players').to.be.true;
                    expect(uniqueIds(match).length).to.eq(match.length);
                    for (const id of match) {
                        ++playerMatchCount[id];
                    }
                }
                const matchesPerPlayer = DEFAULT_SCRIMMAGE_CFG.matchesPerPlayerPerRound[mm.roundIdx];
                expect(Object.values(playerMatchCount)
                    .every(c => c >= matchesPerPlayer), `all player counts >= ${matchesPerPlayer}`).to.be.true;
                mm.advanceRound();
            }
        });
       
        it('keeps at least MATCH_SEATS count players in round', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerRound: [...new Array(Math.ceil(Math.log2(players.playerCount)))].map(() => 1),
                players: players.players,
            });
            while (mm.roundIdx < mm.maxRounds - 1) {
                expect(mm.getRoundPlayers().length).to.eq(
                    Math.max(MATCH_SEATS, Math.ceil(players.playerCount / 2**mm.roundIdx)),
                    'round players',
                );
                mm.advanceRound();
            }
            expect(mm.getRoundPlayers().length).to.eq(MATCH_SEATS);
        });

        it('keeps at least MATCH_SEATS count players in round', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerRound: [...new Array(Math.ceil(Math.log2(players.playerCount)))].map(() => 1),
                players: players.players,
            });
            while (mm.roundIdx < mm.maxRounds - 1) {
                expect(mm.getRoundPlayers().length).to.eq(
                    Math.max(MATCH_SEATS, Math.ceil(players.playerCount / 2**mm.roundIdx)),
                    'round players',
                );
                mm.advanceRound();
            }
            expect(mm.getRoundPlayers().length).to.eq(MATCH_SEATS);
        });

        it('round players have the highest scores', () => {
            const players = new NormalPlayers(100);
            const rankings = new TestPlayerRankings(players.players);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerRound: [...new Array(Math.ceil(Math.log2(players.playerCount)))].map(() => 1),
                rankings,
            });
            for (const id of players.players) {
                rankings.setRawScore(id, Math.random(), Math.random());
            }
            const roundPlayers = mm.getRoundPlayers();
            for (const [idx, id] of roundPlayers.entries()) {
                for (let i = idx + 1; i < roundPlayers.length; ++i) {
                    expect(rankings.getScore(roundPlayers[i])).to.be.lessThanOrEqual(rankings.getScore(id));
                }
            }
        });

        // it('can rank a match result', () => {
        //     const players = new NormalPlayers(100);
        //     const mm = new TestMatchMaker({
        //         ...DEFAULT_SCRIMMAGE_CFG,
        //         players: players.players,
        //     });
        //     const matchPlayers = mm.getNextMatch();
        //     expect(matchPlayers.every(id => mm.getScore(id) === mm.getScore(matchPlayers[0]))).to.be.true;
        //     const matchResult = players.sortPlayers(matchPlayers);
        //     mm.rankMatchResult(matchResult);
        //     const ranked = matchPlayers.sort((a, b) => mm.getScore(b) - mm.getScore(a));
        //     expect(ranked).to.deep.eq(matchResult);
        // });

        // it('rank eventually matches truth', () => {
        //     const players = new NormalPlayers(100);
        //     const rankings = new TestPlayerRankings(players.players);
        //     const mm = new TestMatchMaker({
        //         ...DEFAULT_SCRIMMAGE_CFG,
        //         rankings: rankings,
        //     });
        //     const matchPlayers = mm.getNextMatch();
        //     const matchResult = players.sortPlayers(matchPlayers);
        //     for (let i = 0; i < 10; ++i) {
        //         mm.rankMatchResult(matchResult);
        //     }
        //     const ranked = matchPlayers.sort((a, b) => mm.getScore(b) - mm.getScore(a));
        //     expect(ranked).to.deep.eq(matchResult);
        //     console.log(ranked);
        //     console.log(ranked.map(id => rankings.getConfidence(id)));
        // });

        // it('confidence only increases', () => {
        //     const players = new NormalPlayers(100);
        //     const rankings = new TestPlayerRankings(players.players);
        //     const mm = new TestMatchMaker({
        //         ...DEFAULT_SCRIMMAGE_CFG,
        //         rankings: rankings,
        //     });
        //     const matchPlayers = mm.getNextMatch();
        //     let prevConfidences = matchPlayers.map(id => rankings.getConfidence(id));
        //     for (let i = 0; i < 10; ++i) {
        //         // Make each match result is totally random.
        //         const rr = matchPlayers.map(() => Math.random());
        //         const matchResult = matchPlayers.map((_, i) => i)
        //             .sort((a, b) => rr[a] - rr[b])
        //             .map(i => matchPlayers[i]);
        //         mm.rankMatchResult(matchResult);
        //         const confidences = matchPlayers.map(id => rankings.getConfidence(id));
        //         for (let j = 0; j < matchPlayers.length; ++j) {
        //             expect(confidences[j]).to.be.gt(prevConfidences[j]);
        //         }
        //         prevConfidences = confidences;
        //     }
        // });
    });
});
