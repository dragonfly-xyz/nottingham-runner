import 'colors';
import process from 'process';
import yargs from 'yargs';
import { Hex, Address, isHex, getAddress, createPublicClient, http, decodeEventLog, hexToBytes } from 'viem';
import { PlayerCodes, decryptPlayerSubmission, runTournament } from './run.js';
import { LocalMatchPool } from './pools/local-match-pool.js';
import fs from 'fs/promises';

yargs(process.argv.slice(2)).command(
    'run <season>', 'run a tournament for a season',
    yargs => yargs
        .positional('season', { type: 'number', desc: 'season index', demandOption: true })
        .option('data-url', { alias: 'u', type: 'string', demandOption: true, default: process.env.DATA_URL })
        .option('seed', { alias: 's', type: 'string' })
        .option('privateKey', { alias: 'k', type: 'string', coerce: x => x as Hex })
        .option('brackets', { alias: 'b', type: 'number', array: true, default: [5,5,5] })
        .option('workers', { alias: 'w', type: 'number', default: 8 })
        .option('seats', { alias: 'S', type: 'number', default: 4 })
        .option('player', { alias: 'p', type: 'string', array: true, coerce: x => x.map(s => s.split(':')) as Array<[Address, string]>, default: [] })
        .option('only', { alias: 'o', type: 'string', array: true, coerce: x => x.map(v => getAddress(v)), default: [] })
    ,
    async argv => {
        let players = await fetchJson<Array<{name: string; address: Address;}>>(
            new URL([argv.dataUrl, 'players'].join('/')),
        );
        if (argv.only?.length) {
            players = players.filter(p => argv.only.includes(p.address));
        }

        const addressToName = Object.assign({},
            ...players.map(p => ({ [p.address]: p.name })),
        );

        const privateKey = argv.privateKey
            ? argv.privateKey
            : await fetchSeasonKey(argv.dataUrl, argv.season); 
        const playerCodes = await fetchPlayerCodes(
            argv.season,
            argv.dataUrl,
            privateKey,
            players.map(p => p.address),
        );
        for (const [address, path] of argv.player) {
            let code: Hex;
            if (isHex(path)) {
                code = path;
            } else {
                const { bytecode: { object: code_ } } = JSON.parse(await fs.readFile(path, 'utf-8'));
                code = code_;
            }
            if (code === '0x') {
                delete playerCodes[address];
            } else {
                playerCodes[address] = code;
            }
        }

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
            seed: argv.seed ? argv.seed : privateKey,
        });
        await matchPool.finished();
        timeTaken = Date.now() - timeTaken;
        
        console.log(scores);
        console.log(`Completed after ${(timeTaken / 60e3).toFixed(1)} minutes.`);
        process.exit(0);
    },
).command(
    'last-bytecode <season> [players..]', 'fetch and decrypt player bytecode from a past season',
    yargs => yargs
        .positional('season', { type: 'number', desc: 'season index', demandOption: true })
        .positional('players', { type: 'string', desc: 'player addresses', array: true, coerce: x => x.map(v => getAddress(v)) })
        .option('data-url', { alias: 'u', type: 'string', demandOption: true, default: process.env.DATA_URL })
        .option('privateKey', { alias: 'k', type: 'string', coerce: x => x as Hex })
        .option('for-solc', { alias: 's', desc: 'output as solidit hex strings' })
    ,
    async argv => {
        const privateKey = argv.privateKey
            ? argv.privateKey
            : await fetchSeasonKey(argv.dataUrl, argv.season); 
        const codes = await fetchPlayerCodes(
            argv.season,
            argv.dataUrl,
            privateKey,
            argv.players,
        );
        for (const addr in codes) {
            if (argv.forSolc) {
                console.log(`${addr}:\n${toSolcHex(codes[addr])}`);
            } else {
                console.log(`${addr}:${codes[addr]}`);
            }
        }
    },
).command(
    'tx-bytecode <tx>', 'fetch and decrypt bytecode from a tx hash',
    yargs => yargs
        .positional('tx', { type: 'string', demandOption: true, coerce: x => x as Hex })
        .option('rpc-url', { alias: 'r', type: 'string', demandOption: true })
        .option('data-url', { alias: 'u', type: 'string', demandOption: true, default: process.env.DATA_URL })
        .option('privateKey', { alias: 'k', type: 'string', coerce: x => x as Hex })
    ,
    async argv => {
        const client = createPublicClient({ transport: http(argv.rpcUrl) });
        const r = await client.getTransactionReceipt({ hash: argv.tx });
        let args: any = null;
        for (const log of r.logs) {
            try {
                const decoded = decodeEventLog({
                    abi: [CODE_COMMITTED_ABI],
                    topics: log.topics,
                    data: log.data,
                }) as any;
                args = decoded.args;
            } catch {}
        }
        if (!args) {
            throw new Error(`No CodeCommitted event found`);
        }
        const privateKey = argv.privateKey
            ? argv.privateKey
            : await fetchSeasonKey(argv.dataUrl, args.season);

       const code = decryptPlayerSubmission({
            player: args.player,
            seasonPrivateKey: privateKey,
            codeHash: args.codeHash,
            submission: args.submission,
        });
        console.log(code);
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

function toSolcHex(hex: Hex): string {
    const LINE_LENGTH = 64;
    const raw = hexToBytes(hex);
    const lines = Math.ceil(raw.length / LINE_LENGTH);
    let result = '';
    for (let i = 0; i < lines; ++i) {
        result += `\thex"${Buffer.from(raw.slice(i * LINE_LENGTH, (i+1) * LINE_LENGTH)).toString('hex')}"\n`;
    }
    return result;
}

function compareChainEvents(a: ChainEvent, b: ChainEvent): number {
    if (a.eventBlockNumber === b.eventBlockNumber) {
        if (a.eventTransactionIndex === b.eventTransactionIndex) {
            return a.eventLogIndex - b.eventLogIndex;
        }
        return a.eventTransactionIndex - b.eventTransactionIndex;
    }
    return a.eventBlockNumber - b.eventBlockNumber;
}

async function fetchSeasonKey(dataUrl: string, season: number): Promise<Hex> {
    const { events: seasonEvents } = await fetchJson<{ events: ChainEvent[]}>(
        new URL([dataUrl, 'indexed/seasons'].join('/')),
    );
    for (const event of seasonEvents) {
        if (event.eventName === 'SeasonRevealed') {
            if (event.season === season) {
                return event.privateKey;
            }
        }
    }
    throw new Error(`Season has not yet been revealed.`);
}

async function fetchPlayerCodes(
    season: number,
    dataUrl: string,
    privateKey: Hex,
    players?: Address[],
): Promise<PlayerCodes> {
    const { events: codeEvents } = await fetchJson<{ events: ChainEvent[] }>(
        new URL([dataUrl, 'indexed/code'].join('/')),
        { players, season },
    );
    codeEvents.sort((a, b) => compareChainEvents(b, a));
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
    return Object.assign(
        {},
        ...Object.entries(codes)
           .filter(([,v]) => v !== '0x')
           .map(([k, v]) => ({ [k]: v })),
    );
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

const CODE_COMMITTED_ABI = {
    "type": "event",
    "name": "CodeCommitted",
    "inputs": [
      {
        "name": "season",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "player",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "codeHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "submission",
        "type": "tuple",
        "indexed": false,
        "internalType": "struct EncryptedCodeSubmission",
        "components": [
          {
            "name": "encryptedAesKey",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "encryptedCode",
            "type": "bytes",
            "internalType": "bytes"
          },
          {
            "name": "iv",
            "type": "bytes12",
            "internalType": "bytes12"
          }
        ]
      }
    ],
    "anonymous": false
  };