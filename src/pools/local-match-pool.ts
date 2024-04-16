import { MatchPool, MatchResult, RunMatchParams } from './match-pool.js';
import { LocalNodeCluster } from './local-node-cluster.js';
import { MatchJob } from '../match.js';

export class LocalMatchPool implements MatchPool {
    public static async create(workers: number): Promise<LocalMatchPool> {
        return new LocalMatchPool(await LocalNodeCluster.create(workers));
    }

    private constructor(private readonly _cluster: LocalNodeCluster) {}

    public runMatch(params: RunMatchParams): Promise<MatchResult> {
        return this._cluster.run(new MatchJob({
            id: params.id,
            seed: params.seed,
            players: params.players,
            logger: params.logger,
            timeout: params.timeout,
        }));
    }

    public async finished(): Promise<void> {
        return this._cluster.shutdown();    
    }
}