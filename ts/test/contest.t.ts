import dotenv from 'dotenv';
import { expect } from 'chai';
import { ChildProcess, spawn } from 'child_process';
import { Address, mnemonicToAccount, generateMnemonic, english, privateKeyToAccount } from 'viem/accounts';
import { Abi, HDAccount, Hex, PublicClient, TestClient, Transport, WalletClient, bytesToBigInt, createPublicClient, createTestClient, createWalletClient, http, isAddressEqual, keccak256, padBytes, recoverAddress, toBytes, toHex, zeroAddress } from 'viem';
import CONTEST_ARTIFACT from '../../artifacts/Contest.json' with { type: 'json' };
import { foundry } from 'viem/chains';
import { waitForSuccessfulReceipt } from '../src/evm-utils.js';
import { createSeasonKeys } from '../src/encrypt.js';
import { SeasonState, getCurrentSeason, getLastRevealedSeason, getSeasonKeys, getSeasonPlayers } from '../src/contest.js';
import { randomBytes } from 'crypto';

const CONTEST_ABI = CONTEST_ARTIFACT.abi;
const CONTEST_BYTECODE = CONTEST_ARTIFACT.bytecode.object;

const MNEMONIC = generateMnemonic(english);
const PORT = 9090 + Math.floor(Math.random() * 1000);
const HOST = '127.0.0.1';
const RPC_URL = `http://${HOST}:${PORT}`;
const SEASON_KEYS = [...new Array(3)].map(() => createSeasonKeys());
const COMMON_WRITE_PARAMS = {
    abi: CONTEST_ABI,
    gas: 2e6,
    gasPrice: 0,
    // Hack because TS chokes.
    ...({} as any),
};

describe.only('contest tests', () => {
    let anvilProc: ChildProcess;
    let host: WalletClient;
    let retirer: WalletClient;
    let registrar: HDAccount;
    let transport: Transport;
    let publicClient: PublicClient;
    let contractAddress: Address;
    let testClient: TestClient;
    let snapshots: Hex[] = [];
    let players: WalletClient[];

    before(async () => {
        anvilProc = spawn(
            'anvil',
            [
                '--host', HOST,
                '--port', PORT.toString(),
                '--block-base-fee-per-gas', '0',
                '--silent',
                '--mnemonic', MNEMONIC,
            ],
        );
        transport = http(RPC_URL);
        let accts;
        [registrar, ...accts] = [2, 0, 1]
            .map(idx => mnemonicToAccount(MNEMONIC, { addressIndex: idx }));
        players = [...new Array(8)]
            .map(() => createWalletClient({
                account: privateKeyToAccount(toHex(randomBytes(32))),
                chain: foundry,
                transport,
            }));
        testClient = createTestClient({ transport, chain: foundry, mode: 'anvil' });
        // Hack: TS choking.
        publicClient = (createPublicClient as any)({ chain: foundry, transport });
        [host, retirer] = accts.slice(0, 2).map(acct => 
            createWalletClient({
                account: acct,
                chain: foundry,
                transport,
            }),
        );
        await Promise.all(players
            .map(p => testClient.setBalance({ address: p.account.address, value: BigInt(1e18) })),
        );
        let receipt = await waitForSuccessfulReceipt(publicClient, await retirer.deployContract({
            bytecode: CONTEST_BYTECODE,
            args: [ host.account.address, retirer.account.address, registrar.address ],
            ...COMMON_WRITE_PARAMS,
        }));
        contractAddress = receipt.contractAddress;
        for (const p of players) {
            await registerPlayer(p.account.address);
        }
        await startSeason(0);
    });

    async function pushSnapshot() {
        snapshots.push(await testClient.snapshot());
    }

    async function popSnapshot() {
        await testClient.revert({ id: snapshots.pop() });
    }

    after(async () => {
        anvilProc.kill();
    });

    beforeEach(async () => {
        return pushSnapshot();
    });

    afterEach(async () => {
        return popSnapshot();
    })

    it('can fetch current season', async () => {
        let szn = await getCurrentSeason(publicClient, contractAddress);
        expect(szn).to.eq(0);
        await skipSeason(szn);
        szn = await getCurrentSeason(publicClient, contractAddress);
        expect(szn).to.eq(1);
        await skipSeason(szn);
        szn = await getCurrentSeason(publicClient, contractAddress);
        expect(szn).to.eq(2);
    });

    it('can fetch the last revealed season', async () => {
        expect(await getLastRevealedSeason(publicClient, contractAddress)).to.eq(null);
        await skipSeason(0);
        expect(await getLastRevealedSeason(publicClient, contractAddress)).to.eq(0);
        await closeSeason(1);
        expect(await getLastRevealedSeason(publicClient, contractAddress)).to.eq(0);
        await revealSeasonKey(1);
        expect(await getLastRevealedSeason(publicClient, contractAddress)).to.eq(1);
        await startSeason(2);
        expect(await getLastRevealedSeason(publicClient, contractAddress)).to.eq(1);
    });

    it('can fetch season keys', async () => {
        expect(await getSeasonKeys(publicClient, contractAddress, 0))
            .to.deep.eq({ ...SEASON_KEYS[0], privateKey: null });
        await closeSeason(0);
        await revealSeasonKey(0);
        expect(await getSeasonKeys(publicClient, contractAddress, 0))
            .to.deep.eq(SEASON_KEYS[0]);
        await startSeason(1);
        expect(await getSeasonKeys(publicClient, contractAddress, 0))
            .to.deep.eq(SEASON_KEYS[0]);
        expect(await getSeasonKeys(publicClient, contractAddress, 1))
            .to.deep.eq({ ...SEASON_KEYS[1], privateKey: null });
    });

    it('can fetch season players', async () => {
        expect(await getSeasonPlayers(publicClient, contractAddress, 0)).to.deep.eq({});
        // ...
    });

    async function sign(acc: HDAccount, digest: Hex): Promise<{ v: number; r: Hex; s: Hex }> {
        const sig = acc.getHdKey().sign(toBytes(digest));
        let v = 27;
        const r = sig.slice(0, 32);
        const s = sig.slice(32);
        try {
            const recovered = await recoverAddress({
                hash: digest,
                signature: toHex(Buffer.concat([r, s, Uint8Array.from([v])])),
            });
            v = isAddressEqual(recovered, acc.address) ? v : v + 1;
        } catch (err) {
            v = v + 1;
        }
        return {v, r: toHex(r), s: toHex(s) };
    }
   
    async function registerPlayer(addr: Address): Promise<void> {
        const expiry = Math.floor(Date.now() / 1e3) + 60;
        const nonce = bytesToBigInt(randomBytes(32));
        const digest = hashRegistration(addr, expiry, nonce);
        const { v, r, s } = await sign(registrar, digest);
        await waitForSuccessfulReceipt(publicClient, await host.writeContract({
            address: contractAddress,
            functionName: 'register',
            args: [ addr, { expiry, nonce, r, s, v } ],
            ...COMMON_WRITE_PARAMS,
        }));
    }

    function hashRegistration(player: Address, expiry: number, nonce: bigint): Hex {
        return keccak256(Buffer.concat([
            keccak256(Buffer.from('ᴙɘgiꙅTᴙATioᴎ', 'utf-8'), 'bytes'),
            padBytes(toBytes(contractAddress), { dir: 'left', size: 32 }),
            toBytes(31337, { size: 32 }),
            padBytes(toBytes(player), { dir: 'left', size: 32 }),
            toBytes(expiry, { size: 32 }),
            toBytes(nonce, { size: 32 }),
        ]));
    }

    async function getCurrentSeason_(): Promise<number> {
        return await publicClient.readContract({
            abi: CONTEST_ABI,
            address: contractAddress,
            functionName: 'currentSeasonIdx',
        }) as number;
    }

    async function getSeasonState(szn: number): Promise<SeasonState> {
        return await publicClient.readContract({
            abi: CONTEST_ABI,
            address: contractAddress,
            functionName: 'seasonState',
            args: [szn],
        }) as SeasonState;
    }

    async function skipSeason(szn: number) {
        let state = await getSeasonState(szn);
        if (state === SeasonState.Started) {
            await closeSeason(szn);
            state = SeasonState.Closed;
        }
        if (state === SeasonState.Closed) {
            await revealSeasonKey(szn);
            state = SeasonState.Revealed;
        }
        if (state === SeasonState.Revealed) {
            await startSeason(szn + 1);
        }
    }

    async function closeSeason(szn: number) {
        await waitForSuccessfulReceipt(publicClient, await host.writeContract({
            address: contractAddress,
            functionName: 'closeSeason',
            args: [szn],
            ...COMMON_WRITE_PARAMS,
        }));
    }

    async function revealSeasonKey(szn: number, privateKey?: Hex) {
        privateKey = privateKey ?? SEASON_KEYS[szn].privateKey;
        await waitForSuccessfulReceipt(publicClient, await host.writeContract({
            address: contractAddress,
            functionName: 'revealSeasonKey',
            args: [szn, privateKey],
            ...COMMON_WRITE_PARAMS,
        }));
    }

    async function startSeason(szn: number, publicKey?: Hex) {
        publicKey = publicKey ?? SEASON_KEYS[szn].publicKey;
        await waitForSuccessfulReceipt(publicClient, await host.writeContract({
            address: contractAddress,
            functionName: 'startSeason',
            args: [szn, publicKey, zeroAddress],
            ...COMMON_WRITE_PARAMS,
        }));
    }
});

