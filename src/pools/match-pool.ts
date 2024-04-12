import { Hex } from 'viem';

export type Logger = (name: string, data?: { [key: string]: any }) => void;

export interface PlayerInfos {
    [id: string]: { bytecode: Hex; }
}

export interface RunMatchParams {
    id: string;
    seed: Hex;
    players: PlayerInfos;
    logger?: Logger;
    timeout?: number;
}

export interface MatchResult {
    playerResults: { [id: string]: { gasUsed: number; score: number; } };
}

export interface MatchPool {
    runMatch(params: RunMatchParams): Promise<MatchResult>;
}