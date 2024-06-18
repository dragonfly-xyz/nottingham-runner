import { expect } from 'chai';
import { MatchMaker, MatchMakerConfig } from '../src/matchmaker.js';
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
}

const MATCH_SEATS = 4;

describe('matchmaker tests', () => {
    describe('scrimmage', () => {
        const DEFAULT_SCRIMMAGE_CFG = {
            matchesPerPlayerPerBracket: [1, 2, 3],
            seed: '',
            matchSeats: MATCH_SEATS,
        };

        it('can generate matches', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                players: players.players,
            });
            let bracketCount = 0;
            for (; !mm.isDone(); ++bracketCount) {
                const playersPerMatch = mm.getBracketMatches();
                for (const match of playersPerMatch) {
                    expect(match.every(id => players.isPlayer(id))).to.be.true;
                    expect(uniqueIds(match).length).to.eq(match.length);
                }
                mm.advanceBracket();
            }
            expect(bracketCount).to.eq(DEFAULT_SCRIMMAGE_CFG.matchesPerPlayerPerBracket.length);
            expect(mm.bracketIdx).to.eq(bracketCount);
        });

        it('generates N matches per player per bracket', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                players: players.players,
            });
            while (!mm.isDone()) {
                const playersPerMatch = mm.getBracketMatches();
                const bracketPlayers = mm.getBracketPlayers();
                const playerMatchCount =
                    Object.assign({}, ...bracketPlayers.map(id => ({ [id]: 0 }))) as
                        { [id: string]: number };
                for (const match of playersPerMatch) {
                    expect(match.every(id => players.isPlayer(id)), 'all match ids are valid players').to.be.true;
                    expect(match.every(id => bracketPlayers.includes(id)), 'all match ids are bracket players').to.be.true;
                    expect(uniqueIds(match).length).to.eq(match.length);
                    for (const id of match) {
                        ++playerMatchCount[id];
                    }
                }
                const matchesPerPlayer = DEFAULT_SCRIMMAGE_CFG.matchesPerPlayerPerBracket[mm.bracketIdx];
                expect(Object.values(playerMatchCount)
                    .every(c => c >= matchesPerPlayer), `all player counts >= ${matchesPerPlayer}`).to.be.true;
                mm.advanceBracket();
            }
        });
       
        it('keeps at least MATCH_SEATS count players in bracket', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerBracket: [...new Array(Math.ceil(Math.log2(players.playerCount)))].map(() => 1),
                players: players.players,
            });
            while (mm.bracketIdx < mm.maxBrackets - 1) {
                expect(mm.getBracketPlayers().length).to.eq(
                    Math.max(Math.ceil(MATCH_SEATS * 1.5), Math.ceil(players.playerCount / 2**mm.bracketIdx)),
                    'bracket players',
                );
                mm.advanceBracket();
            }
            expect(mm.getBracketPlayers().length).to.greaterThanOrEqual(MATCH_SEATS);
        });

        it('each bracket is the highest N scoring players', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerBracket: [10, 10, 10],
                players: players.players,
            });
            while (!mm.isDone()) {
                const sortedPlayers = mm.getAllPlayers()
                    .sort((a, b) => mm.getScore(b) - mm.getScore(a));
                const bracketPlayers = mm.getBracketPlayers();
                expect(bracketPlayers).to.deep.eq(
                    sortedPlayers.slice(0, bracketPlayers.length),
                    `players for bracket ${mm.bracketIdx}`,
                );
                const matches = mm.getBracketMatches();
                for (const m of matches) {
                    mm.rankMatchResult(players.sortPlayers(m));
                }
                mm.advanceBracket();
            }
        });

        it('scores according to performance', () => {
            const players = new NormalPlayers(100);
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerBracket: [100, 100, 100],
                players: players.players,
            });
            while (!mm.isDone()) {
                const matches = mm.getBracketMatches();
                for (const m of matches) {
                    mm.rankMatchResult(players.sortPlayers(m));
                }
                mm.advanceBracket();
            }
            // TODO: this will only be loosely in order unless we use
            // very high match count.
            const scores = mm.getScores();
            expect(scores[0].name).eq(players.players[99]);
            expect(scores[99].name).eq(players.players[0]);
        });

        it('getScores() is in range', () => {
            const mm = new TestMatchMaker({
                ...DEFAULT_SCRIMMAGE_CFG,
                matchesPerPlayerPerBracket: [1, 1],
                players: ['a', 'b', 'c'],
                matchSeats: 2,
            });
            while (!mm.isDone()) {
                const matches = mm.getBracketMatches();
                for (const m of matches) {
                    mm.rankMatchResult(m.slice().sort());
                }
                mm.advanceBracket();
            }
            expect(mm.getScore('a')).to.eq(3, 'a');
            expect(mm.getScore('b')).to.eq(2.75, 'b');
            expect(mm.getScore('c')).to.eq(1.5, 'c');
        });

        // it('bracket players have the highest scores', () => {
        //     const players = new NormalPlayers(100);
        //     const rankings = new TestPlayerRankings(players.players);
        //     const mm = new TestMatchMaker({
        //         ...DEFAULT_SCRIMMAGE_CFG,
        //         matchesPerPlayerPerBracket: [...new Array(Math.ceil(Math.log2(players.playerCount)))].map(() => 1),
        //         rankings,
        //     });
        //     for (const id of players.players) {
        //         rankings.setRawScore(id, Math.random());
        //     }
        //     const bracketPlayers = mm.getBracketPlayers();
        //     for (const [idx, id] of bracketPlayers.entries()) {
        //         for (let i = idx + 1; i < bracketPlayers.length; ++i) {
        //             expect(rankings.getScore(bracketPlayers[i])).to.be.lessThanOrEqual(rankings.getScore(id));
        //         }
        //     }
        // });

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
