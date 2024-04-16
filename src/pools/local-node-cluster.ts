import EventEmitter from "events";
import { EvmNode, NodeJob } from "../node.js";
import { delay } from "../util.js";

interface QueuedJob<TResult extends any = void> {
    job: NodeJob<TResult>;
    promise: Promise<TResult>;
    accept: (result: TResult) => void;
    reject: (err?: any) => void;
}

export class LocalNodeCluster extends EventEmitter {
    public static async create(workers: number = 5): Promise<LocalNodeCluster> {
        const startPort = 9000 + Math.floor(Math.random() * 32e3);
        const nodes = await Promise.all(
            [...new Array(workers)].map((_, i) => EvmNode.create(startPort + i)),
        );
        return new LocalNodeCluster(nodes);
    }

    private _runLoopPromise: Promise<void> | undefined;
    private _shutdownCalledPromise: Promise<void>;
    private _shutdownTrigger: () => void;
    private _queue: QueuedJob<any>[] = [];

    private constructor(private readonly _nodes: EvmNode[]) {
        super();
        if (_nodes.length === 0) {
            throw new Error(`Cannot create a 0-node cluster`);
        }
        this._shutdownCalledPromise = new Promise(a => this._shutdownTrigger = a);
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
        if (!this._runLoopPromise) {
            this._runLoopPromise = this._runLoop();
        }
        return qj.promise;
    }

    public async shutdown(): Promise<void> {
        this._queue = [];
        this._shutdownTrigger();
        await Promise.all(this._nodes.map(n => n.shutdown()));
    }

    private async _runLoop(): Promise<void> {
        let shouldShutdown = false;
        const shutdownCalledPromise = this._shutdownCalledPromise.then(() => {
            shouldShutdown = true;
        });
        let jobPromises = [] as Array<Promise<any>>;
        while (!shouldShutdown) {
            const availableNodes = this._nodes.filter(n => n.isIdle);
            const newJobs = this._queue.splice(
                0,
                Math.min(this._queue.length, availableNodes.length),
            );
            jobPromises.push(...newJobs.map((j, i) => {
                const p = availableNodes[i].run(j.job)
                    .then(r => j.accept(r))
                    .catch(e => j.reject(e))
                    .finally(() => {
                        const idx = jobPromises.indexOf(p);
                        if (idx === -1) {
                            throw new Error(`Cannot find match promise`);
                        }
                        jobPromises.splice(idx, 1);
                        this.emit('completed', { job: j.job });
                    });
                return p;
            }));
            try {
                await Promise.race([
                    ...jobPromises,
                    shutdownCalledPromise,
                    delay(100),
                ]);
            } catch (err) {}
        }
    }
}