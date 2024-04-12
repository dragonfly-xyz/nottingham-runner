import dotenv from 'dotenv';
dotenv.config();
import 'colors';
import process from 'process';
import yargs from 'yargs';
import {
    Hex,
    Address,
    keccak256,
    toHex,
    createPublicClient,
    http,
    Chain,
} from 'viem';
import { getLastRevealedSeason, getSeasonKeys, getSeasonPlayers } from './contest.js';
import { MatchMaker } from './matchmaker.js';
import { LocalMatchPool } from './pools/local-match-pool.js';
import { MatchPool } from './pools/match-pool.js';
import { decryptPlayerCode, deriveSeasonPublicKey } from './encrypt.js';
import { zkSync, mainnet } from 'viem/chains';

yargs(process.argv.slice(0)).command(
    '$0', 'run a tournament on the current (closed) season',
    yargs => yargs
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
        .option('mode', { alias: 'm', type: 'string', choices: ['tournament', 'scrimmage'], default: 'scrimmage' })
        .option('season', { alias: 's', type: 'number', desc: 'explicit season index' })
        .option('privateKey', { alias: 'k', type: 'string', coerce: s => toHex(s) })
        .option('rpc-url', { alias: 'r', type: 'string', default: process.env.RPC_URL })
    ,
    async argv => runTournament({
        contestAddress: argv.address,
        mode: argv.mode == 'tournament' ? MatchMakingMode.Tournament : MatchMakingMode.Scrimmage,
        poolConfig: { workerCount: 4 },
        szn: argv.season,
        privateKey: argv.privateKey,
        rpcUrl: argv.rpcUrl,
        chain: (argv.zksync ? zkSync : mainnet) as Chain,
    }),
).argv;

interface LocalPoolConfig {
    workerCount: number;
}

interface RemotePoolConfig {
    // TODO
}

interface TournamentConfig {
    rpcUrl: string;
    contestAddress: Address;
    mode: MatchMakingMode;
    poolConfig: LocalPoolConfig | RemotePoolConfig;
    chain: Chain,
}

interface PrivateTournamentConfig extends TournamentConfig {
    szn: number;
    privateKey: Hex;
}

const SCRIMMAGE_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [2, 3, 4],
};

const TOURNAMENT_MATCHMAKER_CONFIG = {
    matchesPerPlayerPerRound: [3, 4, 6, 10],
};

enum MatchMakingMode {
    Scrimmage = 'scrimmage',
    Tournament = 'tournament',
}

function isPrivateTournamentConfig(cfg: TournamentConfig | PrivateTournamentConfig)
    : cfg is PrivateTournamentConfig
{
    return typeof((cfg as any).szn) === 'number' && (cfg as any).privateKey;
}

async function runTournament(cfg: TournamentConfig | PrivateTournamentConfig) {
    const client = createPublicClient({ chain: mainnet, transport: http(cfg.rpcUrl, { retryCount: 3 }) });

    let szn: number;
    let privateKey: Hex;
    let publicKey: Hex;
    if (isPrivateTournamentConfig(cfg)) {
        szn = cfg.szn;
        privateKey = cfg.privateKey;
        publicKey = deriveSeasonPublicKey(privateKey);
    } else {
        const szn_ = await getLastRevealedSeason(client, cfg.contestAddress);
        if (szn_ === null) {
            throw new Error(`No season has been revealed yet.`);
        }
        szn = szn_;
        const keys = await getSeasonKeys(client, cfg.contestAddress, szn);
        privateKey = keys.privateKey!;
        publicKey = keys.publicKey!;
    }
    const playerCodes = Object.assign({},
        ...Object.entries(await getSeasonPlayers(client, cfg.contestAddress, szn))
            .map(([id, { codeHash, encryptedAesKey, encryptedCode, iv }]) => {
                let code: Hex;
                try {
                    code = decryptPlayerCode(
                        privateKey,
                        id as Hex,
                        { encryptedAesKey, encryptedCode, iv },
                    );
                    if (keccak256(code) !== codeHash) {
                        throw new Error(`Code hash does not match decrypted submission.`);
                    }
                } catch (err) {
                    console.warn(`Failed to decrypt submission from ${id}:`, err);
                    return {};
                }
                return { [id as Address]: code };
            }),
        );
    console.log(`Running ${cfg.mode} for season ${szn}, ${Object.keys(playerCodes).length} players...`);

    const seed = keccak256(Buffer.from(publicKey));
    const pool = await createMatchPool(cfg.poolConfig);
    const mm: MatchMaker = new MatchMaker({
        ...(cfg.mode === MatchMakingMode.Tournament
                ? TOURNAMENT_MATCHMAKER_CONFIG
                : SCRIMMAGE_MATCHMAKER_CONFIG
            ),
        seed,
        players: Object.keys(playerCodes),
    });
    while (!mm.isDone()) {
        let matchCount = 0;
        let matchPromises = [] as Array<Promise<any>>;
        const playersPerMatch = mm.getRoundMatches();
        for (const matchPlayers of playersPerMatch) {
            ++matchCount;
            matchPromises.push((async () => {
                try {
                    const result = await pool.runMatch({
                        seed,
                        players: Object.assign(
                            {},
                            ...matchPlayers.map(id => ({ bytecode: playerCodes[id] })),
                        ),
                    });
                    mm.rankMatchResult(
                        Object.keys(result.playerResults)
                        .sort((a, b) => result.playerResults[b].score - result.playerResults[a].score),
                    );
                } catch (err) {
                    console.error(`Match with players ${matchPlayers.join(', ')} failed: `, err.message);
                } finally {
                    --matchCount;
                }
            })());
        }
        while (matchCount > 0) {
            await Promise.race(matchPromises);
            console.info(`Matches left: ${matchCount}...`);
        }
    }
    console.log(`Scores: ${JSON.stringify(mm.getScores())}`);
}

function isLocalPoolConfig(cfg: LocalPoolConfig | RemotePoolConfig): cfg is LocalPoolConfig {
    return (cfg as LocalPoolConfig).workerCount !== undefined;
}

async function createMatchPool(cfg?: unknown): Promise<MatchPool> {
    if (isLocalPoolConfig(cfg)) {
        return LocalMatchPool.create(cfg.workerCount);
    }
    throw new Error('unimplemented');
}