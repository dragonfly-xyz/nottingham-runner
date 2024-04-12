import { ChildProcess, spawn } from "child_process";
import {
    Hex,
    PublicClient,
    WalletClient,
    createPublicClient,
    createWalletClient,
    http,
} from "viem";
import { foundry } from "viem/chains";

const BLOCK_GAS_LIMIT = 32e9;
const MAX_CODE_SIZE = 0x8000;

export interface NodeInfo {
    blockGasLimit: number;
    wallet: WalletClient;
    client: PublicClient;
}

export interface NodeJob<TResult extends any = void> {
    run(node: NodeInfo): Promise<TResult>;
}

export class EvmNode {
    public static async create(): Promise<EvmNode> {
        const port = 9000 + Math.floor(Math.random() * 10e3);
        const proc = spawn(
            'anvil',
            [
                '--host', '127.0.0.1',
                '--port', port.toString(),
                '--gas-limit', BLOCK_GAS_LIMIT.toString(),
                '--gas-price', '0',
                '--code-size-limit', MAX_CODE_SIZE.toString(),
                '--block-base-fee-per-gas', '0',
                '--no-cors',
                '--silent',
                '--mnemonic-random',
                '--prune-history',
            ],
        );
        await new Promise<void>((accept, reject) => {
            proc.on('close', code => {
                reject(new Error(`anvil process terminated early (code: ${code})`));
            });
            proc.stderr.on('data', data => {
                console.error(data.toString());
            });
            setTimeout(accept, 500);
        });
        proc.removeAllListeners();
        proc.stdout.removeAllListeners();
        const transport = http(`http://127.0.0.1:${port}`, { timeout: 30e3 });
        const wallet = createWalletClient({
            transport,
            chain: foundry,
            account: (await createWalletClient({ transport }).getAddresses())[0],
        });
        const client = (createPublicClient as any)({ transport }) as PublicClient; 
        const initialStateDump = await createPublicClient({ transport })
            .request({ method: 'anvil_dumpState', params: [] }) as Hex;
        return new EvmNode({ proc, wallet, client, initialStateDump });
    }

    private readonly _proc: ChildProcess;
    private readonly _wallet: WalletClient;
    private readonly _client: PublicClient;
    private readonly _initialStateDump: Hex;
    private _isDead: boolean = false;
    private _currentJob: NodeJob<any> | undefined;

    private constructor(info: {
        proc: ChildProcess;
        wallet: WalletClient;
        client: PublicClient;
        initialStateDump: Hex;
    }) {
        
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
        try {
            return (async () => {
                await this._client.request({ method: 'anvil_loadState', params: [this._initialStateDump] });
                return job.run({ wallet: this._wallet, client: this._client, blockGasLimit: BLOCK_GAS_LIMIT });
            })();
        } catch (err) {
            console.error(`Node job failed with: ${err?.message ?? err}`);
            throw err;
        } finally {
            this._currentJob = undefined;
        }
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