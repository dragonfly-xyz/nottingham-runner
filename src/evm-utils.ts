
import {
    AbiEvent,
    Address,
    Hex,
    Log,
    PublicClient,
    TransactionReceipt,
    decodeEventLog,
    isAddressEqual,
} from "viem";

export interface LogEventHandlerData<TArgs extends {} = {}> {
    logIndex: number;
    emitter: Address;
    args: TArgs;
}

export type LogEventHandlerCallback<TArgs = any> = (data: LogEventHandlerData<TArgs>) => boolean | void;
export type LogEventHandler<TArgs = any> = {
    event: AbiEvent;
    handler: LogEventHandlerCallback<TArgs>,
    emitter?: Address;
};

export function handleLogEvents(
    logs: Log[],
    ...handlers: LogEventHandler[]
): void {
    const eventAbis = handlers.map(h => h.event);
    outer: for (const log of logs) {
        let decoded: { eventName: string; args: { [name: string]: unknown } };
        for (const [i, abi] of eventAbis.entries()) {
            const handler = handlers[i];
            try {
                if (handler.emitter &&
                    !isAddressEqual(log.address, handler.emitter))
                {
                    continue;
                }
                decoded = decodeEventLog({
                    abi: [abi],
                    topics: (log as any).topics,
                    data: log.data,
                }) as any;
                if (handler.handler({
                        args: decoded.args,
                        emitter: log.address,
                        logIndex: log.logIndex,
                    }) === false)
                {
                    break outer;
                }
            } catch {}
        }
    }
}

export async function waitForSuccessfulReceipt(
    client: PublicClient,
    hash: Hex,
): Promise<TransactionReceipt> {
    const r = await client.waitForTransactionReceipt({ hash, timeout: 5e3 });
    if (r.status !== 'success') {
        throw new Error(`tx ${hash} failed`);
    }
    return r;
}

function logOrdinal(log: Log): number {
    return (Number(log.blockNumber) << 32) | log.transactionIndex;
}

export function sortLogs(logs: Log[], reversed: boolean = true): Log[] {
    return logs.slice().sort(reversed
        ? (a, b) => logOrdinal(b) - logOrdinal(a)
        : (a, b) => logOrdinal(a) - logOrdinal(b)
    );
}