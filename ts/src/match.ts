import {
    Address,
    Hex,
    Log,
    PublicClient,
    WalletClient,
} from "viem";
import { AbiEvent } from "abitype";
import GAME_DEPLOYER_ARTIFACT from "../../artifacts/GameDeployer.json" with { type: "json" };
import GAME_ABI from "../../artifacts/Game.abi.json" with { type: "json" };
import { LogEventHandler, LogEventHandlerData, handleLogEvents, waitForSuccessfulReceipt } from "./evm-utils.js";
import { NodeInfo, NodeJob } from "./node.js";

const ALL_EVENTS = [...GAME_ABI, ...GAME_DEPLOYER_ARTIFACT.abi].filter(o => o.type === 'event') as AbiEvent[];

export interface PlayerInfo {
    id: string;
    bytecode: Hex;
}

export type Logger = (name: string, data?: { [key: string]: any }) => void;

export interface MatchResult {
    scores: PlayerScore[];
}

export interface PlayerScore {
    id: string;
    score: number;
}

interface RoundResult {
    isGameOver: boolean;
    timeTaken: number;
    playerGasUsage: number[];
}

type GameCreatedEventArgs = LogEventHandlerData<{ game: Address; }>;
type CreatePlayerFailedEventArgs = LogEventHandlerData<{ playerIdx: Address; }>;
type RoundPlayedEventArgs = LogEventHandlerData<{ round: number; }>;
type GameOverEventArgs = LogEventHandlerData<{ rounds: number; winnerIdx: number; }>;
type PlayerBlockUsageGasUsageEventArgs = LogEventHandlerData<{ builderIdx: number; gasUsed: number; }>;

const DEFAULT_LOGGER: Logger = (name, data) => {
    if (data) {
        console.debug(name, JSON.stringify(data));
    } else {
        console.debug(name);
    }
};

export class MatchJob implements NodeJob<MatchResult> {
    private _isCanceled = false;
    private _gameAddress?: Address; 
    private _client?: PublicClient;
    private _wallet?: WalletClient;
    private _gasLimit?: number;

    public constructor(
        public readonly seed: Hex,
        public readonly players: PlayerInfo[],
        public readonly logger: Logger = DEFAULT_LOGGER,
    ) {}

    public async cancel(err?: Error): Promise<void> {
        this._isCanceled = true;
    }

    public async run(node: NodeInfo): Promise<MatchResult> {
        this._client = node.client;
        this._wallet = node.wallet;
        this._gasLimit = node.blockGasLimit;
        this._gameAddress = await this._deployGame();
        while (true) {
            if (this._isCanceled) {
                throw new Error(`Match cancelled`);
            }
            const roundResult = await this._playRound();
            if (roundResult.isGameOver) break;
        }
        const scores = await this._getScores();
        this.logger('game_over', { scores });
        return { scores };
    }

    private async _deployGame(): Promise<Address> {
        try {
            const receipt = await waitForSuccessfulReceipt(
                this._client!,
                // HACK: TS autocomplete choking.
                await (this._wallet.deployContract as any)({
                    abi: GAME_DEPLOYER_ARTIFACT.abi,
                    bytecode: GAME_DEPLOYER_ARTIFACT.bytecode.object as Hex,
                    args: [this.seed, this.players.map(p => p.bytecode)],
                }),
            );
            handleLogEvents(
                receipt.logs, 
                ALL_EVENTS,
                {
                    name: 'GameCreated',
                    handler: ({ args: { game: game_ } }: GameCreatedEventArgs) => {
                        this._gameAddress = game_;
                    },
                    emitter: receipt.contractAddress,
                },
            );
            if (!this._gameAddress) {
                throw new Error(`Failed to create game.`);
            }
            this._handleGameEvents(
                receipt.logs,
                {
                    'CreatePlayerFailed': ({ args: { playerIdx }}: CreatePlayerFailedEventArgs) => {
                        this.logger(
                            'create_player_failed',
                            { player: this.players[playerIdx].id },
                        );
                    }
                },
            );
            this.logger('created', { players: this.players.map(p => p.id) });
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
        const playerGasUsage = this.players.map(() => 0);
        this._handleGameEvents(receipt.logs,
            {
                'RoundPlayed': ({ args: { round } }: RoundPlayedEventArgs) => {
                    this.logger('round_played', { round, gas: Number(receipt.gasUsed) });
                },
                'GameOver': (_: GameOverEventArgs) => { isGameOver = true; },
                'PlayerBlockGasUsage':
                    ({ args: { builderIdx, gasUsed } }: PlayerBlockUsageGasUsageEventArgs) =>
                        { playerGasUsage[builderIdx] = gasUsed; },
            }
        );
        return { isGameOver, playerGasUsage, timeTaken };
    }

    private async _getScores(): Promise<PlayerScore[]> {
        const r = await this._readGameContract<bigint[]>('scorePlayers');
        return r
            .map((_,i) => i)
            .sort((a, b) => r[a] == r[b] ? 0 : (r[a] < r[b] ? 1 : -1))
            .map(i => ({ id: this.players[i].id, score: Number(r[i]) / 1e18 }));
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

    private _handleGameEvents(
        logs: Log[],
        handlers: { [eventName: string]: LogEventHandler; },
    ): void {
        handleLogEvents(
            logs,
            ALL_EVENTS,
            ...Object.entries(handlers).map(([name, handler]) => ({
                emitter: this._gameAddress!,
                name,
                handler,
            })),
        );
    }
}