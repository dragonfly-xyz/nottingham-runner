import process from "process";
import CONTEST_ABI from "../../artifacts/Contest.abi.json";
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
    keccak256,
    ByteArray,
    toBytes,
} from "viem";
// import { zkSync } from "viem/chains";
import { EncryptedCodeSubmission, decryptPlayerCode } from "./encrypt.js";

const EVENTS = CONTEST_ABI.filter(e => e.type === 'event') as AbiEvent[]
const RETIRED_EVENT = EVENTS.find(e => e.name === 'Retired');
const CODE_COMMITED_EVENT = EVENTS.find(e => e.name === 'CodeCommited');
const SEASON_STARTED_EVENT = EVENTS.find(e => e.name === 'SeasonStarted');
const SEASON_CLOSED_EVENT = EVENTS.find(e => e.name === 'SeasonClosed');

interface CodeCommittedEvent extends DecodeEventLogReturnType {
    eventName: 'CodeCommited';
    args: readonly unknown[] & {
        season: bigint;
        player: Address;
        codeHash: Hex;
        submission: EncryptedCodeSubmission;
    };
}

interface RetiredEvent extends DecodeEventLogReturnType {
    eventName: 'Retired';
    args: readonly unknown[] & {
        player: Address;
    };
}

interface SeasonStartedEvent extends DecodeEventLogReturnType {
    eventName: 'SeasonStarted';
    args: readonly unknown[] & {
        season: number;
        publicKey: Hex;
    };
}

interface SeasonClosedEvent extends DecodeEventLogReturnType {
    eventName: 'SeasonClosed';
    args: readonly unknown[] & {
        season: number;
        privateKey: Hex;
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
        let [publicKey, privateKey] = await Promise.all([
            (async () => {
                const [ log ] = await this._readClient.getLogs({
                    address: this.address,
                    event: SEASON_STARTED_EVENT,
                    args: { season: BigInt(seasonIdx) },
                });
                if (!log) {
                    return null;
                }
                return (decodeEventLog({
                    abi: [ SEASON_STARTED_EVENT ],
                    data: log.data,
                    topics: log.topics,
                }) as SeasonStartedEvent).args.publicKey;
            })(),
            (async () => {
                const [ log ] = await this._readClient.getLogs({
                    address: this.address,
                    event: SEASON_CLOSED_EVENT,
                    args: { season: BigInt(seasonIdx) },
                });
                if (!log) {
                    return null;
                }
                return (decodeEventLog({
                    abi: [ SEASON_CLOSED_EVENT ],
                    data: log.data,
                    topics: log.topics,
                }) as SeasonClosedEvent).args.privateKey;
            })(),
        ]);
        return { publicKey, privateKey };
    }

    public async getActivePlayersForSeason(seasonInfo: SeasonInfo)
        : Promise<{ [address: Address]: Hex }>
    {
        if (!seasonInfo.privateKey) {
            throw new Error(`No private key for season ${seasonInfo.idx}.`);
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
                // Retirement is permanent.
                commits[addr] = '0x';
            } else {
                if (!commits[addr]) {
                    try {
                        const bytecode = decryptPlayerCode(
                            seasonInfo.privateKey,
                            addr,
                            decoded.args.submission,
                        );
                        if (keccak256(bytecode) !== decoded.args.codeHash) {
                            throw new Error(`Mismatched code hash.`);
                        }
                        commits[addr] = bytecode;
                    } catch (err) {
                        console.warn(`Player (${addr}) submission failed: ${err.message}`);
                        // On failure, do not fall back to prior submissions to mitigate DoS.
                        commits[addr] = '0x';
                    }
                }
            }
        }
        return Object.assign(
            {},
            ...Object.entries(commits)
                .filter(([k, v]) => v && v !== '0x')
                .map(([k, v]) => ({ [k]: v })),
        );
    }

    public async beginNewSeason(seasonIdx: number, topPlayer: Address, publicKey: Hex): Promise<number> {
        // ...
        return seasonIdx;
    }
}

function toEventOrdinal(log: { blockNumber: number, logIndex: number }): number {
    return (log.blockNumber << 64) | log.logIndex;
}
