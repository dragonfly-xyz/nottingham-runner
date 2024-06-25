import { ChildProcess, spawn } from "child_process";
import {
    Hex,
    PublicClient,
    WalletClient,
    createPublicClient,
    createWalletClient,
    webSocket,
} from "viem";
import { foundry } from "viem/chains";
import { env } from 'process';
import crypto from 'crypto';

const BLOCK_GAS_LIMIT = 32e9;
export const MAX_CODE_SIZE = 0x8000;

export interface NodeInfo {
    blockGasLimit: number;
    wallet: WalletClient;
    client: PublicClient;
}

export interface NodeJob<TResult extends any = void> {
    run(node: NodeInfo): Promise<TResult>;
}

export class EvmNode {
    public static async create(port: number = 9090): Promise<EvmNode> {
        const proc = spawn(
            env.ANVIL_BIN ?? 'anvil',
            [
                '--host', '127.0.0.1',
                '--port', port.toString(),
                '--gas-limit', BLOCK_GAS_LIMIT.toString(),
                '--gas-price', '0',
                '--code-size-limit', (MAX_CODE_SIZE * 5).toString(),
                '--base-fee', '0',
                '--hardfork', 'cancun',
                '--silent',
                '--mnemonic-random',
                '--accounts', '1',
                '--order', 'fifo',
                '--prune-history',
                '--transaction-block-keeper', '1'
            ],
            { detached: false },
        );
        proc.unref();
        // proc.stdout.on('data', d => {
        //     process.stdout.write(d);
        // })
        // proc.stderr.on('data', d => {
        //     process.stderr.write(d);
        // })
        await new Promise<void>((accept, reject) => {
            proc.on('close', code => {
                reject(new Error(`anvil process terminated early (code: ${code})`));
            });
            proc.stderr.on('data', data => {
                console.error(data.toString());
            });
            setTimeout(accept, 500);
        });
        const transport = webSocket(
            `ws://127.0.0.1:${port}`,
            {
                timeout: 120e3,
                retryCount: 2,
                retryDelay: 500,
            },
        );
        const wallet = createWalletClient({
            transport,
            chain: foundry,
            account: (await createWalletClient({ transport }).getAddresses())[0],
            cacheTime: 0,
        });
        const client = (createPublicClient as any)({ cacheTime: 0, transport }) as PublicClient; 
        const initialStateDump = await createPublicClient({ transport })
            .request({ method: 'anvil_dumpState', params: [] }) as Hex;
        return new EvmNode({ proc, wallet, client, initialStateDump });
    }

    public readonly id: string;
    private readonly _proc: ChildProcess;
    private readonly _wallet: WalletClient;
    private readonly _client: PublicClient;
    private readonly _initialStateDump: Hex;
    private _isDead: boolean = false;
    private _currentJob: NodeJob<any> | undefined;

    private constructor(info: {
        id?: string;
        proc: ChildProcess;
        wallet: WalletClient;
        client: PublicClient;
        initialStateDump: Hex;
    }) {
        this.id = info.id ?? crypto.randomUUID();
        this._proc = info.proc;
        this._wallet = info.wallet;
        this._client = info.client;
        this._initialStateDump = info.initialStateDump;
        info.proc.on('close', code => {
            this._isDead = true;
            if (code) {
                console.error(`EVM node worker exited with error code ${code}!`);
            }
        });
    }

    public run<TResult>(job: NodeJob<TResult>): Promise<TResult> {
        if (this._isDead) {
            throw new Error(`Node ${this._proc.pid} is dead.`);
        }
        if (this._currentJob) {
            throw new Error(`Node ${this._proc.pid} already has a job running.`);
        }
        this._currentJob = job;
        console.debug(`Running job on node ${this.id}...`);
        return (async () => {
            await this._client.request({ method: 'anvil_loadState', params: [this._initialStateDump] });
            try {
                const res = await job.run({
                    wallet: this._wallet,
                    client: this._client,
                    blockGasLimit: BLOCK_GAS_LIMIT,
                });
                return res;
            } catch (err) {
                console.error(`Node job failed on ${this.id} with: ${err}`);
                throw err;
            } finally {
                this._currentJob = undefined;
                console.debug(`Finished job on node ${this.id}.`);
            }
        })();
    }

    public async request<TResult = void>(method: string, params: any[] = []): Promise<TResult> {
        return this._client.request({ method, params }) as TResult;
    }

    public async shutdown(): Promise<void> {
        this._currentJob = undefined;
        this._isDead = true;
        this._proc.kill();
    }

    public get isDead(): boolean {
        return this._isDead;
    }

    public get isIdle(): boolean {
        return !this._currentJob;
    }
}