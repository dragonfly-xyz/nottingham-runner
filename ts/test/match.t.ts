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
        let gameOverLogData;
        const job = new MatchJob(
            seed,
            [
                { id: 'a', bytecode: EMTPY_BYTECODE },
                { id: 'b', bytecode: EMTPY_BYTECODE },
                { id: 'c', bytecode: EMTPY_BYTECODE },
            ],
            (name, data) => {
                if (name === 'game_over') {
                    gameOverLogData = data;
                }
            },
        );
        const { scores } = await node.run(job);
        expect(gameOverLogData?.scores?.length).to.eq(3);
        expect(scores.map(s => s.id)).to.deep.eq(['a','b','c']);
    });

    it('can run a match with failing to deploy player', async () => {
        const seed = toHex(crypto.randomBytes(32));
        const failedDeploys = [];
        const job = new MatchJob(
            seed,
            [
                { id: 'a', bytecode: EMTPY_BYTECODE },
                { id: 'b', bytecode: FAILING_DEPLOY_BYTECODE },
            ],
            (name, data) => {
                if (name === 'create_player_failed') {
                    failedDeploys.push(data.player);
                }
            },
        );
        const { scores } = await node.run(job);
        expect(scores.map(s => s.id)).to.deep.eq(['a', 'b']);
        expect(failedDeploys).to.deep.eq(['b']);
    });

    it('can run a match with failing player', async () => {
        const seed = toHex(crypto.randomBytes(32));
        const job = new MatchJob(
            seed,
            [
                { id: 'a', bytecode: EMTPY_BYTECODE },
                { id: 'b', bytecode: FAILING_PLAYER_BYTECODE },
            ],
            () => {},
        );
        const { scores } = await node.run(job);
        expect(scores.map(s => s.id)).to.deep.eq(['a', 'b']);
    });

    it('can run a match with eternal players', async () => {
        const seed = toHex(crypto.randomBytes(32));
        let gameOverLogData;
        const job = new MatchJob(
            seed,
            [
                { id: 'a', bytecode: ETERNAL_PLAYER_BYTECODE },
                { id: 'b', bytecode: ETERNAL_PLAYER_BYTECODE },
                { id: 'c', bytecode: ETERNAL_PLAYER_BYTECODE },
            ],
            (name, data) => {
                if (name === 'game_over') {
                    gameOverLogData = data;
                } else if (name === 'round_played') {
                    console.log(data.round, data.gas);
                }
            },
        );
        const { scores } = await node.run(job);
        expect(gameOverLogData?.scores?.length).to.eq(3);
        expect(scores.map(s => s.id)).to.deep.eq(['a', 'b', 'c']);
    });
});