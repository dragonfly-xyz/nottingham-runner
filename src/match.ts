import {
    AbiEvent,
    Address,
    Hex,
    PublicClient,
    WalletClient,
} from "viem";
import GAME_DEPLOYER_ARTIFACT from "../artifacts/GameDeployer.json";
import GAME_ABI from "../artifacts/Game.abi.json";
import { LogEventHandler, handleLogEvents, waitForSuccessfulReceipt } from "./evm-utils.js";
import { NodeInfo, NodeJob } from "./node.js";
import { MatchResult, Logger, PlayerInfos } from './pools/match-pool.js';

const ALL_EVENTS = [...GAME_ABI, ...GAME_DEPLOYER_ARTIFACT.abi].filter(o => o.type === 'event') as AbiEvent[];
const EVENT_BY_NAME = Object.assign({}, ...ALL_EVENTS.map(e => ({ [e.name]: e })));

interface RoundResult {
    isGameOver: boolean;
    timeTaken: number;
}

interface PlayerBundleEventParam {
    fromAssetIdx: number;
    toAssetIdx: number;
    fromAmount: bigint;
    minToAmount: bigint;
}

type GameCreatedEventArgs = { game: Address; };
type CreatePlayerFailedEventArgs = { playerIdx: Address; };
type RoundPlayedEventArgs = { round: number; };
type GameOverEventArgs = { rounds: number; winnerIdx: number; };
type PlayerBlockUsageGasUsageEventArgs = { builderIdx: number; gasUsed: number; };
type PlayerBundleGasUsageEventArgs = { playerIdx: number; gasUsed: number; };
type CreateBundleFailedEventArgs = { playerIdx: number; builderIdx: number; revertData: Hex; };
type MintEventArgs = { playerIdx: number; assetIdx: number; assetAmount: bigint; };
type BurnEventArgs = { playerIdx: number; assetIdx: number; assetAmount: bigint; };
type TransferEventArgs = { fromPlayerIdx: number; toPlayerIdx: number; assetIdx: number; assetAmount: bigint; };
type BlockBidEventArgs = { builderIdx: number; bid: bigint };
type BlockBuiltEventArgs = { round: number; builderIdx: number; bid: bigint };
type EmptyBlockEventArgs = { round: number; };
type SwapEventArgs = { playerIdx: number; fromAssetIdx: number; toAssetIdx: number; fromAmount: bigint; toAmount: bigint; };
type BundleSettledEventArgs = { playerIdx: number; success: boolean; bundle: PlayerBundleEventParam };


const DEFAULT_LOGGER: Logger = (name, data) => {
    if (data) {
        console.debug(name, JSON.stringify(data));
    } else {
        console.debug(name);
    }
};

export class MatchJob implements NodeJob<MatchResult> {
    private _gameAddress?: Address; 
    private _client?: PublicClient;
    private _wallet?: WalletClient;
    private _gasLimit?: number;
    private readonly _logger: Logger;
    private readonly _gasByPlayer: { [id: string]: number };
    private readonly _playerIdsByIdx: string[];

    public constructor(
        private readonly id: string,
        private readonly _seed: Hex,
        private readonly _players: PlayerInfos,
        logger: Logger = DEFAULT_LOGGER,
        private readonly _timeout: number = 10 * 60e3,
    ) {
        this._logger = (name, data) => logger(name, { ...data, matchId: this.id });
        this._playerIdsByIdx = Object.keys(_players);
        this._gasByPlayer = Object.assign(
            {},
            ...Object.keys(_players).map(id => ({ [id]: 0 })),
        );
    }

    public async run(node: NodeInfo): Promise<MatchResult> {
        let timedOut = false;
        const timeoutTimer = setTimeout(() => timedOut = true, this._timeout);
        for (const id in this._gasByPlayer) {
            this._gasByPlayer[id] = 0;
        }
        this._client = node.client;
        this._wallet = node.wallet;
        this._gasLimit = node.blockGasLimit;
        this._gameAddress = await this._deployGame();
        while (!timedOut) {
            const roundResult = await this._playRound();
            if (roundResult.isGameOver) break;
        }
        if (timedOut) {
            throw new Error('match timed out');
        }
        const scores = await this._getScores();
        this._logger('game_over', { scores });
        clearTimeout(timeoutTimer);
        return {
            playerResults: Object.assign(
                {},
                ...this._playerIdsByIdx.map((id, i) => ({
                    [id]: {
                        gasUsed: this._gasByPlayer[id],
                        score: scores[i],
                    },
                })),
            ),
        };
    }

    private async _deployGame(): Promise<Address> {
        try {
            const receipt = await waitForSuccessfulReceipt(
                this._client!,
                // HACK: TS autocomplete choking.
                await (this._wallet.deployContract as any)({
                    abi: GAME_DEPLOYER_ARTIFACT.abi,
                    bytecode: GAME_DEPLOYER_ARTIFACT.bytecode.object as Hex,
                    args: [this._seed, this._playerIdsByIdx.map(id => this._players[id].bytecode)],
                }),
            );
            handleLogEvents(
                receipt.logs, 
                {
                    event: EVENT_BY_NAME.GameCreated,
                    handler: ({ args: { game: game_ } }) => {
                        this._gameAddress = game_;
                        this._logger('game_created', { _players: this._playerIdsByIdx });
                    },
                    emitter: receipt.contractAddress,
                } as LogEventHandler<GameCreatedEventArgs>,
                {
                    event: EVENT_BY_NAME.CreatePlayerFailed,
                    handler: ({ args: { playerIdx }}) => {
                        this._logger('create_player_failed', { player: this._playerIdsByIdx[playerIdx] });
                    }
                } as LogEventHandler<CreatePlayerFailedEventArgs>,
            );
            if (!this._gameAddress) {
                throw new Error(`Failed to create game.`);
            }
            this._logger('created', { players: this._playerIdsByIdx });
            return this._gameAddress;
        } catch (err: any) {
            throw(`Failed to deploy game: ${err.message}`);
        }
    }

    private async _playRound(): Promise<RoundResult> {
        let timeTaken = Date.now();
        const receipt = await waitForSuccessfulReceipt(
            this._client!,
            await (this._wallet.writeContract as any)({
                abi: GAME_ABI,
                address: this._gameAddress!,
                functionName: 'playRound',
                args: [],
                gasLimit: this._gasLimit!,
                gasPrice: 0,
            }),
        );
        timeTaken = Date.now() - timeTaken;
        let isGameOver = false;
        handleLogEvents(receipt.logs,
            {
                event: EVENT_BY_NAME.RoundPlayed,
                handler: ({ args: { round } }) => {
                    this._logger('round_played', { round, gas: Number(receipt.gasUsed) });
                },
            } as LogEventHandler<RoundPlayedEventArgs>,
            {
                event: EVENT_BY_NAME.GameOver,
                handler: ({ args: { rounds, winnerIdx } }) => {
                    isGameOver = true;
                    this._logger('game_over', { rounds, winnerIdx, gas: Number(receipt.gasUsed) });
                },
            } as LogEventHandler<GameOverEventArgs>,
            {
                event: EVENT_BY_NAME.PlayerBlockGasUsage,
                handler: ({ args: { builderIdx, gasUsed } }) => {
                    this._gasByPlayer[this._playerIdsByIdx[builderIdx]] += gasUsed;
                },
            } as LogEventHandler<PlayerBlockUsageGasUsageEventArgs>,
            {
                event: EVENT_BY_NAME.PlayerBundleGasUsage,
                handler: ({ args: { playerIdx, gasUsed } }) => {
                    this._gasByPlayer[this._playerIdsByIdx[playerIdx]] += gasUsed;
                },
            } as LogEventHandler<PlayerBundleGasUsageEventArgs>,
            {
                event: EVENT_BY_NAME.Mint,
                handler: ({ args: { assetIdx, playerIdx, assetAmount } }) => {
                    this._logger('mint', { playerIdx, assetIdx, assetAmount });
                },
            } as LogEventHandler<MintEventArgs>,
            {
                event: EVENT_BY_NAME.Burn,
                handler: ({ args: { assetIdx, playerIdx, assetAmount } }) => {
                    this._logger('burn', { playerIdx, assetIdx, assetAmount });
                },
            } as LogEventHandler<BurnEventArgs>,
            {
                event: EVENT_BY_NAME.Transfer,
                handler: ({ args: { fromPlayerIdx, toPlayerIdx, assetIdx, assetAmount } }) => {
                    this._logger('transfer', { fromPlayerIdx, toPlayerIdx, assetIdx, assetAmount });
                },
            } as LogEventHandler<TransferEventArgs>,
            {
                event: EVENT_BY_NAME.Swap,
                handler: ({ args: { playerIdx, fromAssetIdx, toAssetIdx, fromAmount, toAmount } }) => {
                    this._logger('swap', {
                        playerIdx,
                        fromAssetIdx,
                        toAssetIdx,
                        fromAmount,
                        toAmount,
                    });
                },
            } as LogEventHandler<SwapEventArgs>,
            {
                event: EVENT_BY_NAME.BundleSettled,
                handler: ({ args: { playerIdx, success, bundle } }) => {
                    this._logger('bundle_settled', { playerIdx, success, bundle });
                },
            } as LogEventHandler<BundleSettledEventArgs>,
            {
                event: EVENT_BY_NAME.BlockBuilt,
                handler: ({ args: { builderIdx, bid } }) => {
                    this._logger('block_built', { builderIdx, bid });
                },
            } as LogEventHandler<BlockBuiltEventArgs>,
            {
                event: EVENT_BY_NAME.EmptyBlock,
                handler: ({ args: { }}) => {
                    this._logger('empty_block', {});
                },
            } as LogEventHandler<EmptyBlockEventArgs>, 
        );
        return { isGameOver, timeTaken };
    }

    private async _getScores(): Promise<number[]> {
        const r = await this._readGameContract<bigint[]>('scorePlayers');
        return r
            .map((_,i) => i)
            .sort((a, b) => r[a] == r[b] ? 0 : (r[a] < r[b] ? 1 : -1))
            .map(i => Number(r[i]) / 1e18);
    }

    private async _readGameContract<TResult extends any = void>(
        functionName: string,
        args: any[] = [],
    ): Promise<TResult> {
        return this._client.readContract({
            abi: GAME_ABI,
            address: this._gameAddress!,
            functionName: functionName,
            args,
        }) as Promise<TResult>;
    }
}