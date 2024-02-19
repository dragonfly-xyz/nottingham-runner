import process from "process";
import CONTEST_ABI from "../../artifacts/Contest.abi.json";
import { AbiEvent } from "abitype";
import {
    Abi,
    zeroHash,
    Hex,
    Address,
    createWalletClient,
    http,
    WalletClient,
    PublicClient,
    createPublicClient,
    decodeEventLog,
    DecodeEventLogReturnType,
    checksumAddress,
    keccak256,
} from "viem";
// import { zkSync } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Decrypter } from "./decrypt.js";

const EVENTS = CONTEST_ABI.filter(e => e.type === 'event') as AbiEvent[]
const RETIRED_EVENT = EVENTS.find(e => e.name === 'Retired');
const CODE_COMMITED_EVENT = EVENTS.find(e => e.name === 'CodeCommited');

interface CodeCommittedEvent extends DecodeEventLogReturnType {
    eventName: 'CodeCommited';
    args: readonly unknown[] & {
        season: bigint;
        player: Address;
        codeHash: Hex;
        encryptedCode: Hex;
    };
}

interface RetiredEvent extends DecodeEventLogReturnType {
    eventName: 'Retired';
    args: readonly unknown[] & {
        player: Address;
    };
}

function isRetiredEvent(decoded: DecodeEventLogReturnType): decoded is RetiredEvent {
    return decoded.eventName === 'Retired';
}

export interface SeasonInfo {
    idx: number;
    publicKey: Hex | null;
    privateKey: Hex | null;
}

export class Contest {
    private _readClient: PublicClient; 
    private _wallet?: WalletClient;

    public constructor(public readonly address: Address) {
        const transport = http(process.env.RPC_URL, { retryCount: 2 });
        // HACK: Makes TS autocomplete painfully slow without `any`.
        this._readClient = (createPublicClient as any)({ transport });
        if (process.env.HOST_PRIVATE_KEY) {
            this._wallet = createWalletClient({
                key: process.env.HOST_PRIVATE_KEY || zeroHash,
                transport,
                // chain: zkSync,
            });
        }
    }

    public async getSeasonInfo(seasonIdx: number): Promise<SeasonInfo> {
        const { publicKey, privateKey } = await this.getSeasonKeys(seasonIdx);
        return {
            idx: seasonIdx,
            publicKey: publicKey, 
            privateKey: privateKey,
        };
    }

    public async getCurrentSeasonInfo(): Promise<SeasonInfo> {
        const seasonIdx = await this.getCurrentSeasonIdx();
        return this.getSeasonInfo(seasonIdx);
    }

    public async getCurrentSeasonIdx(): Promise<number> {
        return Number(await this._readClient.readContract({
            abi: CONTEST_ABI,
            address: this.address,
            functionName: 'currentSeasonIdx',
            args: [],
        }) as bigint);
    }

    public async getSeasonKeys(seasonIdx: number):
        Promise<{ publicKey: Hex | null, privateKey: Hex | null }>
    {
        let { publicKey, privateKey } = await this._readClient.readContract({
            abi: CONTEST_ABI,
            address: this.address,
            functionName: 'getSeasonKeys',
            args: [seasonIdx],
        }) as { publicKey: Hex, privateKey: Hex };
        if (publicKey === zeroHash || privateKey === zeroHash) {
            const seasonKeys = (process.env?.SEASON_PRIVATE_KEYS ?? '')
                .split(',')
                .filter(s => s) as Hex[];
            if (seasonKeys.length > seasonIdx) {
                privateKey = seasonKeys[seasonIdx];
                const acct = privateKeyToAccount(privateKey);
                publicKey = acct.publicKey;
            }
        }
        return {
            publicKey: publicKey === zeroHash ? null : publicKey,
            privateKey: privateKey === zeroHash ? null : privateKey,
        };
    }

    public async getActivePlayersForSeason(seasonInfo: SeasonInfo)
        : Promise<{ [address: Address]: Hex }>
    {
        if (!seasonInfo.privateKey) {
            throw new Error(`No private key for season ${seasonInfo.idx}.`);
        }
        const decrypter = new Decrypter(seasonInfo.privateKey);
        const events = (await Promise.all([
            this._readClient.getLogs({
                address: this.address,
                event: CODE_COMMITED_EVENT,
                args: { season: BigInt(seasonInfo.idx) },
            }),
            this._readClient.getLogs({
                address: this.address,
                event: RETIRED_EVENT,
            }),
        ]))
            .flat(1)
            .sort((a, b) => toEventOrdinal(b) - toEventOrdinal(a));
        const commits = {} as { [address: Address]: Hex };
        for (const e of events) {
            const decoded = decodeEventLog({ abi: CONTEST_ABI, data: e.data, topics: e.topics }) as
                (CodeCommittedEvent | RetiredEvent);
            const addr = checksumAddress(decoded.args.player);
            if (isRetiredEvent(decoded)) {
                if (!commits[addr]) {
                    commits[addr] = '0x';
                }
            } else {
                if (!commits[addr]) {
                    const bytecode = decrypter.decrypt(decoded.args.encryptedCode);
                    if (keccak256(bytecode) !== decoded.args.encryptedCode) {
                        console.warn(`Player ${addr} provided invalid code hash.`);
                        delete commits[addr];
                    } else {
                        commits[addr] = bytecode;
                    }
                }
            }
        }
        return commits;
    }

    public async beginNewSeason(seasonIdx: number, topPlayer: Address, publicKey: Hex): Promise<number> {
        // ...
        return seasonIdx;
    }
}

function toEventOrdinal(log: { blockNumber: number, logIndex: number }): number {
    return (log.blockNumber << 64) | log.logIndex;
}