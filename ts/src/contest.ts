import CONTEST_ARTIFACT from '../../artifacts/Contest.json' with { type: 'json' };
import { AbiEvent } from 'abitype';
import {
    Hex,
    Address,
    Log, 
    createPublicClient,
    decodeEventLog,
    DecodeEventLogReturnType,
    PublicClient,
} from 'viem';
// import { zkSync } from 'viem/chains';
import { EncryptedCodeSubmission } from './encrypt.js';
import { LogEventHandler, handleLogEvents, sortLogs } from './evm-utils.js';

const CONTEST_ABI = CONTEST_ARTIFACT.abi;
const EVENTS = CONTEST_ABI.filter(e => e.type === 'event') as AbiEvent[]
const RETIRED_EVENT = EVENTS.find(e => e.name === 'Retired');
const CODE_COMMITED_EVENT = EVENTS.find(e => e.name === 'CodeCommited');
const SEASON_STARTED_EVENT = EVENTS.find(e => e.name === 'SeasonStarted');
const SEASON_REVEALED_EVENT = EVENTS.find(e => e.name === 'SeasonRevealed');

export enum SeasonState {
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

export async function getLastRevealedSeason(client: PublicClient, contestAddress: Address)
: Promise<number | null>
{
    let szn = Number(await client.readContract({
        address: contestAddress,
        abi: CONTEST_ABI,
        functionName: 'currentSeasonIdx',
        args: [],
    }));
    const state = Number(await client.readContract({
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

export async function getCurrentSeason(client: PublicClient, contestAddress: Address)
: Promise<number | null>
{
    let szn = Number(await client.readContract({
        address: contestAddress,
        abi: CONTEST_ABI,
        functionName: 'currentSeasonIdx',
        args: [],
    }));
    const state = Number(await client.readContract({
        address: contestAddress,
        abi: CONTEST_ABI,
        functionName: 'seasonState',
        args: [szn],
    }));
    if (state === SeasonState.Inactive) {
        return null;
    }
    return szn;
}

export async function getSeasonKeys(client: PublicClient, contestAddress: Address, szn: number, startBlock?: number)
    : Promise<{ publicKey: Hex | null; privateKey: Hex | null; }>
{
    let [publicKey, privateKey] = await Promise.all([
        (async () => {
            const [ log ] = await client.getLogs({
                address: contestAddress,
                event: SEASON_STARTED_EVENT,
                args: { season: BigInt(szn) },
                fromBlock: startBlock ? BigInt(startBlock) : 'earliest',
            });
            if (!log) {
                return null;
            }
            return ((log as any).args as SeasonStartedEventArgs)?.publicKey;
        })(),
        (async () => {
            const [ log ] = await client.getLogs({
                address: contestAddress,
                event: SEASON_REVEALED_EVENT,
                args: { season: BigInt(szn) },
                fromBlock: startBlock ? BigInt(startBlock) : 'earliest',
            });
            if (!log) {
                return null;
            }
            return ((log as any).args as SeasonRevealedEventArgs)?.privateKey;
        })(),
    ]);
    return { publicKey, privateKey };
}

export async function getSeasonPlayers(client: PublicClient, contestAddress: Address, szn: number)
    : Promise<{ [player: Address]: { codeHash: Hex; } & EncryptedCodeSubmission }>
{
    const logs = sortLogs((await Promise.all([
        client.getLogs({
            address: contestAddress,
            event: CODE_COMMITED_EVENT,
            args: { season: BigInt(szn) },
        }),
        client.getLogs({
            address: contestAddress,
            event: RETIRED_EVENT,
        }),
    ])).flat(1), true);
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