import { expect } from "chai";
import { EvmNode } from "../src/node.js";

describe('node tests', () => {
    let node: EvmNode;

    before(async () => {
        node = await EvmNode.create(9091);
    })
    
    after(async () => {
        if (node) {
            await node.shutdown();
        }
    });
    
    it('can spin up a node', async () => {
        const r = await node.request<{ environment: { chainId: number } }>('anvil_nodeInfo');
        expect(r.environment.chainId).to.eq(31337);
    });
});