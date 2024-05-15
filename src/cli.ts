import 'colors';
import process from 'process';
import yargs from 'yargs';
import { Hex, PublicClient, createPublicClient, getAddress, http } from 'viem';
import { MatchMakingMode, runTournament } from './run.js';
import { LocalMatchPool } from './pools/local-match-pool.js';
import { mainnet } from 'viem/chains';

yargs(process.argv.slice(2)).command(
    '$0 <season>', 'run a scrimmage or tournament for a season',
    yargs => yargs
        .positional('season', { type: 'number', desc: 'season index', demandOption: true })
        .option('address', {
            alias: 'a',
            type: 'string',
            demandOption: true,
            desc: 'contest contract address',
            coerce: arg => arg as Hex,
        })
        .option('mode', { alias: 'm', type: 'string', choices: ['tournament', 'scrimmage'], default: 'tournament' })
        .option('season-key', { alias: 'k', type: 'string' })
        .option('rpc-url', { alias: 'r', type: 'string', default: process.env.RPC_URL })
        .option('workers', { alias: 'w', type: 'number', default: 8 })
        .option('whitelist', { alias: 'W', type: 'string', array: true })
    ,
    async argv => {
        if (!argv.rpcUrl) {
            throw new Error(`No RPC URL found`);
        }
        const client = (createPublicClient as any)({
            chain: mainnet,
            transport: http(argv.rpcUrl, { retryCount: 3 }),
        }) as PublicClient;

        let timeTaken = Date.now();
        const matchPool = await LocalMatchPool.create(argv.workers);
        const scores = await runTournament({
            client,
            matchPool,
            contestAddress: argv.address,
            mode: argv.mode == 'tournament' ? MatchMakingMode.Tournament : MatchMakingMode.Scrimmage,
            szn: argv.season,
            seasonPrivateKey: argv.seasonKey as Hex,
            logger: (name, data) => {
                console.log(`${name}: ${JSON.stringify(data)}`);
            },
            whitelist: argv.whitelist ? argv.whitelist.map(v => getAddress(v)) : undefined,
        });
        await matchPool.finished();
        timeTaken = Date.now() - timeTaken;
        
        console.log(scores);
        console.log(`Completed after ${(timeTaken / 60e3).toFixed(1)} seconds.`);
    },
).parse();