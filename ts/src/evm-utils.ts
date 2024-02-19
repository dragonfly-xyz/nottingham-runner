
import {
    Abi,
    Address,
    Hex,
    Log,
    PublicClient,
    TransactionReceipt,
    decodeEventLog,
    isAddressEqual,
} from "viem";
import { AbiEvent } from "abitype";

export interface LogEventHandlerData<TArgs extends {} = {}> {
    logIndex: number;
    emitter: Address;
    args: TArgs;
}

export type LogEventHandler = (data: LogEventHandlerData) => boolean | void;

export function handleLogEvents(
    logs: Log[],
    events: AbiEvent[],
    ...handlers: Array<{
        name: string;
        handler: LogEventHandler,
        emitter?: Address;
    }>
): void {
    outer: for (const log of logs) {
        let decoded: { eventName: string; args: { [name: string]: unknown } };
        try {
            decoded = decodeEventLog({
                abi: events as Abi,
                topics: (log as any).topics,
                data: log.data,
            }) as any;
            for (const handler of handlers) {
                if (handler.emitter && !isAddressEqual(log.address, handler.emitter)) {
                    continue;
                }
                if (handler.name !== decoded.eventName) {
                    continue;
                }
                const r = handler.handler({
                    args: decoded.args,
                    emitter: log.address,
                    logIndex: log.logIndex,
                });
                if (r === false) {
                    break outer;
                }
            }
        } catch (err) {
            console.log(err);
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
