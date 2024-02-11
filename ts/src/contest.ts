import process from "process";
import * as CONTEST_ABI from "../../abis/Contest.json";
import { AbiEvent } from "abitype";
import {
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
} from "viem";
import { zkSync } from "viem/chains";
import { decryptByteCode } from "./decrypt";

const EVENTS = CONTEST_ABI.filter(e => e.type === 'event') as AbiEvent[]
const RETIRED_EVENT = EVENTS.find(e => e.name === 'Retired');
const CODE_COMMITED_EVENT = EVENTS.find(e => e.name === 'CodeCommited');

interface CodeCommittedEvent extends DecodeEventLogReturnType {
    eventName: 'CodeCommited';
    args: readonly unknown[] & {
        season: bigint;
        player: Address;
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
    private _wallet: WalletClient;

    public constructor(public readonly address: Address) {
        const transport = http(process.env.RPC_URL, { retryCount: 2 });
        // HACK: Makes TS autocomplete painfully slow without `any`.
        this._readClient = (createPublicClient as any)({ transport });
        this._wallet = createWalletClient({
            key: process.env.PRIVATE_KEY || zeroHash,
            transport,
            chain: zkSync,
        });
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
        }) as bigint);
    }

    public async getSeasonKeys(seasonIdx: number):
        Promise<{ publicKey: Hex | null, privateKey: Hex | null }>
    {
        const { publicKey, privateKey } = await this._readClient.readContract({
            abi: CONTEST_ABI,
            address: this.address,
            functionName: 'getSeasonKeys',
        }) as { publicKey: Hex, privateKey: Hex };
        return {
            publicKey: publicKey === zeroHash ? null : publicKey,
            privateKey: privateKey === zeroHash ? null : privateKey,
        };
    }

    public async getActivePlayersForSeason(seasonInfo: SeasonInfo)
        : Promise<{ [address: Address]: Hex }>
    {
        if (!seasonInfo.privateKey) {
            throw new Error(`Season ${seasonInfo.idx} not yet closed!`);
        }
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
                    commits[addr] = decryptByteCode(
                        decoded.args.encryptedCode,
                        seasonInfo.privateKey,
                    );
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