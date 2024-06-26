import { expect } from "chai";
import { EvmNode } from "../src/node.js";
import { MatchJob } from "../src/match.js";
import crypto from "crypto";
import { toHex } from "viem";

const EMTPY_BYTECODE = '0x';
const FAILING_DEPLOY_BYTECODE = '0xfe';
const FAILING_PLAYER_BYTECODE = '0x60fe5f526001601ff3';
const ETERNAL_PLAYER_BYTECODE = '0x625b5f565f526003601df3';

describe('match tests', () => {
    let node: EvmNode;

    before(async () => {
        node = await EvmNode.create();
    })
    after(async () => {
        await node.shutdown();
    });
    
    it('can run a match with empty players', async () => {
        const seed = toHex(crypto.randomBytes(32));
        let finalScoresLogData;
        const job = new MatchJob({
            seed,
            players: {
                ['a']: { bytecode: EMTPY_BYTECODE },
                ['b']: { bytecode: EMTPY_BYTECODE },
                ['c']: { bytecode: EMTPY_BYTECODE },
            },
            logger: (name, data) => {
                if (name === 'final_scores') {
                    finalScoresLogData = data;
                }
            },
    });
        const { playerResults } = await node.run(job);
        expect(finalScoresLogData?.scores?.length).to.eq(3);
        expect(Object.keys(playerResults)).to.deep.eq(['a','b','c']);
    });

    it('can run a match with failing to deploy player', async () => {
        const seed = toHex(crypto.randomBytes(32));
        const failedDeploys = [] as string[];
        const job = new MatchJob({
            seed,
            players: {
                ['a']: { bytecode: EMTPY_BYTECODE },
                ['b']: { bytecode: FAILING_DEPLOY_BYTECODE },
            },
            logger: (name, data) => {
                if (name === 'create_player_failed') {
                    failedDeploys.push(data.player);
                }
            },
        });
        const { playerResults } = await node.run(job);
        expect(Object.keys(playerResults)).to.deep.eq(['a', 'b']);
        expect(failedDeploys).to.deep.eq(['b']);
    });

    it('can run a match with failing player', async () => {
        const seed = toHex(crypto.randomBytes(32));
        const job = new MatchJob({
            seed,
            players: {
                ['a']: { bytecode: EMTPY_BYTECODE },
                ['b']: { bytecode: FAILING_PLAYER_BYTECODE },
            },
            logger: () => {},
        });
        const { playerResults } = await node.run(job);
        expect(Object.keys(playerResults)).to.deep.eq(['a', 'b']);
    });

    it.skip('can run a match with eternal players', async () => {
        const seed = toHex(crypto.randomBytes(32));
        const job = new MatchJob({
            seed,
            players: {
                ['a']: { bytecode: ETERNAL_PLAYER_BYTECODE },
                ['b']: { bytecode: ETERNAL_PLAYER_BYTECODE },
                ['c']: { bytecode: ETERNAL_PLAYER_BYTECODE },
                ['d']: { bytecode: ETERNAL_PLAYER_BYTECODE },
            },
            logger: (name, data) => {
                if (name === 'round_played') {
                    console.log(data.round, data.gas, data.timeTaken);
                }
            },
        });
        const { playerResults } = await node.run(job);
        expect(Object.keys(playerResults)).to.deep.eq(['a', 'b', 'c', 'd']);
    });
});