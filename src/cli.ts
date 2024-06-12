import 'colors';
import process from 'process';
import yargs from 'yargs';
import { Hex, Address } from 'viem';
import { PlayerCodes, decryptPlayerSubmission, runTournament } from './run.js';
import { LocalMatchPool } from './pools/local-match-pool.js';

yargs(process.argv.slice(2)).command(
    '$0 <season>', 'run a tournament for a season',
    yargs => yargs
        .positional('season', { type: 'number', desc: 'season index', demandOption: true })
        .option('data-url', { alias: 'u', type: 'string', demandOption: true, default: process.env.DATA_URL })
        .option('seed', { alias: 's', type: 'string' })
        .option('brackets', { alias: 'b', type: 'number', array: true, default: [5,5,5] })
        .option('workers', { alias: 'w', type: 'number', default: 8 })
        .option('seats', { alias: 'S', type: 'number', default: 4 })
    ,
    async argv => {
        const players = await fetchJson<Array<{name: string; address: Address;}>>(
            new URL('/players', argv.dataUrl),
        );
        const addressToName = Object.assign({},
            ...players.map(p => ({ [p.address]: p.name })),
        );
        const playerCodes = await fetchPlayerCodes(
            argv.season,
            argv.dataUrl,
            players.map(p => p.address),
        );

        let timeTaken = Date.now();
        const matchPool = await LocalMatchPool.create(argv.workers);
        const scores = await runTournament({
            matchPool,
            logger: (name, data) => {
                console.log(`${name}: ${JSON.stringify(data)}`);
            },
            brackets: argv.brackets,
            players: Object.assign({},
                ...Object.entries(playerCodes).map(([addr, code]) => ({
                    [addressToName[addr]]: code,
                })),
            ),
            matchSeats: argv.seats,
            seed: argv.seed,
        });
        await matchPool.finished();
        timeTaken = Date.now() - timeTaken;
        
        console.log(scores);
        console.log(`Completed after ${(timeTaken / 60e3).toFixed(1)} minutes.`);
    },
).parse();

interface ChainEvent {
    eventId: string;
    eventBlockNumber: number;
    eventTransactionIndex: number;
    eventLogIndex: number;
    eventName: string;
    [field: string]: any;
}

export async function fetchPlayerCodes(
    season: number,
    dataUrl: string,
    players?: Address[],
): Promise<PlayerCodes>
{
    const { events: seasonEvents } = await fetchJson<{ events: ChainEvent[]}>(
        new URL('/indexed/seasons', dataUrl),
    );
    let privateKey: Hex | null = null;
    for (const event of seasonEvents) {
        if (event.eventName === 'SeasonRevealed') {
            if (event.season === season) {
                privateKey = event.privateKey;
                break;
            }
        }
    }
    if (!privateKey) {
        throw new Error(`Season ${season} has not yet been revealed.`);
    }
    const { events: codeEvents } = await fetchJson<{ events: ChainEvent[] }>(
        new URL('/indexed/code', dataUrl),
        { players, season },
    );
    const codes = {} as PlayerCodes;
    for (const event of codeEvents) {
        if (event.eventName !== 'CodeCommitted') {
            continue;
        }
        try {
            codes[event.player] = decryptPlayerSubmission({
                player: event.player,
                seasonPrivateKey: privateKey,
                codeHash: event.codeHash,
                submission: event.submission,
            });
        } catch (err) {
            console.warn(`Failed to decrypt player ${event.player}: ${err}`);
        }
    }
    return codes;
}

async function fetchJson<T = object>(
    url: string | URL,
    searchParams: URLSearchParams | Record<string, any> = {},
): Promise<T> {
    const url_ = new URL(url);
    url_.search = new URLSearchParams(searchParams).toString();
    const resp = await fetch(url_);
    if (!resp.ok) {
        throw new Error(`${resp.statusText}: ${await resp.text()}`);
    }
    return await resp.json() as T;
}
