import EventEmitter from "events";
import { EvmNode, NodeJob } from "./node.js";

interface QueuedJob<TResult extends any = void> {
    job: NodeJob<TResult>;
    promise: Promise<TResult>;
    accept: (result: TResult) => void;
    reject: (err?: any) => void;
}

export class NodeCluster extends EventEmitter {
    public static async create(workers: number = 5): Promise<NodeCluster> {
        const nodes = await Promise.all(
            [...new Array(workers)].map(() => EvmNode.create()),
        );
        return new NodeCluster(nodes);
    }

    private _queue: QueuedJob<any>[] = [];

    private constructor(private readonly _nodes: EvmNode[]) {
        super();
        if (_nodes.length === 0) {
            throw new Error(`Cannot create a 0-node cluster`);
        }
    }

    public get queueSize(): number {
        return this._queue.length;
    }

    public get workerCount(): number {
        return this._nodes.length;
    }

    public run<TResult extends any = void>(job: NodeJob<TResult>): Promise<TResult> {
        const qj = { job, promise: null, accept: null, reject: null };
        qj.promise = new Promise<string[]>(function (accept, reject) {
            qj.accept = accept;
            qj.reject = reject;
        });
        this._queue.push(qj);
        if (this.queueSize === 0) {
            this._runLoop();
        }
        return qj.promise;
    }

    public async shutdown(): Promise<void> {
        this._queue = [];
        await Promise.all(this._nodes.map(n => n.shutdown()));
    }

    public async cancelAll(): Promise<void> {
        this._queue = [];
        await Promise.all(this._nodes.map(n => n.cancel()));
    }

    private async _runLoop(): Promise<void> {
        let jobPromises = [] as Array<Promise<any>>;
        while (this._queue.length) {
            const availableNodes = this._nodes.filter(n => n.isIdle);
            const newJobs = this._queue.slice(
                this._queue.length - this.workerCount,
                this._queue.length - this.workerCount + jobPromises.length,
            );
            jobPromises.push(...newJobs.map((j, i) => {
                const p = availableNodes[i].run(j.job);
                return p.then(r => j.accept(r))
                    .catch(e => j.reject(e))
                    .finally(() => {
                        const idx = jobPromises.indexOf(p);
                        if (idx !== -1) {
                            jobPromises.splice(idx, 1);
                        }
                        this.emit('completed', { job: j.job });
                    });
            }));
            try {
                await Promise.race(jobPromises);
            } catch (err) {}
        }
    }
}