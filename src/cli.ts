import dotenv from 'dotenv';
dotenv.config();
import 'colors';
import process from 'process';
import yargs from 'yargs';
import {
    Hex,
    toHex,
    Chain,
} from 'viem';
import { zkSync, mainnet } from 'viem/chains';
import { MatchMakingMode, runTournament } from './run.js';

yargs(process.argv.slice(0)).command(
    '$0 <season>', 'run a tournament on the current (closed) season',
    yargs => yargs
        .positional('season', { type: 'number', desc: 'season index' })
        .option('address', {
            alias: 'a',
            type: 'string',
            demandOption: true,
            desc: 'contest contract address',
            coerce: arg => arg as Hex,
        })
        .option('zksync', {
            alias: 'z',
            desc: 'use zksync network',
        })
        .option('mode', { alias: 'm', type: 'string', choices: ['tournament', 'scrimmage'], default: 'tournament' })
        .option('season-key', { alias: 'k', type: 'string', coerce: s => toHex(s) })
        .option('rpc-url', { alias: 'r', type: 'string', default: process.env.RPC_URL })
    ,
    async argv => {
        const scores = runTournament({
            contestAddress: argv.address,
            mode: argv.mode == 'tournament' ? MatchMakingMode.Tournament : MatchMakingMode.Scrimmage,
            poolConfig: { workerCount: 8 },
            szn: argv.season,
            seasonPrivateKey: argv.seasonKey,
            rpcUrl: argv.rpcUrl,
            chain: (argv.zksync ? zkSync : mainnet) as Chain,
        });
        console.log(scores);
    },
).argv;