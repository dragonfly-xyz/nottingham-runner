import process from "process";
import CONTEST_ABI from "../../artifacts/Contest.abi.json";
import { AbiEvent } from "abitype";
import {
    Hex,
    Address,
    http,
    createPublicClient,
    decodeEventLog,
    DecodeEventLogReturnType,
} from "viem";
// import { zkSync } from "viem/chains";
import { EncryptedCodeSubmission } from "./encrypt.js";
import { LogEventHandler, handleLogEvents, sortLogs } from "./evm-utils.js";

const EVENTS = CONTEST_ABI.filter(e => e.type === 'event') as AbiEvent[]
const RETIRED_EVENT = EVENTS.find(e => e.name === 'Retired');
const CODE_COMMITED_EVENT = EVENTS.find(e => e.name === 'CodeCommited');
const SEASON_STARTED_EVENT = EVENTS.find(e => e.name === 'SeasonStarted');
const SEASON_REVEALED_EVENT = EVENTS.find(e => e.name === 'SeasonRevealed');

enum SeasonState {
    Inactive = 0,
    Started = 1,
    Closed = 2,
    Revealed = 3,
}

interface CodeCommittedEventArgs {
    season: bigint;
    player: Address;
    codeHash: Hex;
    submission: EncryptedCodeSubmission;
}

interface RetiredEventArgs {
    player: Address;
}

interface SeasonStartedEventArgs {
    season: number;
    publicKey: Hex;
}

interface SeasonRevealedEventArgs extends DecodeEventLogReturnType {
    season: number;
    privateKey: Hex;
}

const CLIENT = createPublicClient({ transport: http(process.env.RPC_URL, { retryCount: 2 }) });

export async function getLastRevealedSeason(contestAddress: Address): Promise<number | null> {    
    let szn = Number(await CLIENT.readContract({
        address: contestAddress,
        abi: CONTEST_ABI,
        functionName: 'currentSeasonIdx',
        args: [],
    }));
    const state = Number(await CLIENT.readContract({
        address: contestAddress,
        abi: CONTEST_ABI,
        functionName: 'seasonState',
        args: [szn],
    }));
    if (state !== SeasonState.Revealed) {
        if (szn === 0) {
            return null;
        }
        szn -= 1;
    }
    return szn;
}

export async function getSeasonKeys(contestAddress: Address, szn: number)
    : Promise<{ publicKey: Hex | null; privateKey: Hex | null; }>
{
    let [publicKey, privateKey] = await Promise.all([
        (async () => {
            const [ log ] = await CLIENT.getLogs({
                address: contestAddress,
                event: SEASON_STARTED_EVENT,
                args: { season: BigInt(szn) },
            });
            if (!log) {
                return null;
            }
            decodeEventLog({
                abi: [ SEASON_STARTED_EVENT ],
                data: log.data,
                topics: log.topics,
            })
            return ((decodeEventLog({
                abi: [ SEASON_STARTED_EVENT ],
                data: log.data,
                topics: log.topics,
            }) as any)?.args as SeasonStartedEventArgs)?.publicKey;
        })(),
        (async () => {
            const [ log ] = await CLIENT.getLogs({
                address: contestAddress,
                event: SEASON_REVEALED_EVENT,
                args: { season: BigInt(szn) },
            });
            if (!log) {
                return null;
            }
            return ((decodeEventLog({
                abi: [ SEASON_REVEALED_EVENT ],
                data: log.data,
                topics: log.topics,
            }) as any)?.args as SeasonRevealedEventArgs)?.privateKey;
        })(),
    ]);
    return { publicKey, privateKey };
}

export async function getSeasonPlayers(contestAddress: Address, szn: number)
    : Promise<{ [player: Address]: { codeHash: Hex; } & EncryptedCodeSubmission }>
{
    const logs = sortLogs((await Promise.all([
        this._readClient.getLogs({
            address: contestAddress,
            event: CODE_COMMITED_EVENT,
            args: { season: BigInt(szn) },
        }),
        this._readClient.getLogs({
            address: contestAddress,
            event: RETIRED_EVENT,
        }),
    ])), true);
    const commits = {} as {
        [player: Address]: ({ codeHash: Hex; } & EncryptedCodeSubmission) | null
    };
    handleLogEvents(
        logs,
        {
            event: CODE_COMMITED_EVENT,
            handler: ({ args: { player, codeHash, submission } }) => {
                if (player in commits) {
                    commits[player] = { codeHash, ...submission };
                }
            },
        } as LogEventHandler<CodeCommittedEventArgs>,
        { 
            event: RETIRED_EVENT,
            handler: ({ args: { player } }) => {
                commits[player] = null;
            },
        } as LogEventHandler<RetiredEventArgs>,
    )
    return Object.assign({},
        ...Object.entries(commits)
            .filter(([k, v]) => !!v)
            .map(([k, v]) => ({ [k]: v })),
    );
}