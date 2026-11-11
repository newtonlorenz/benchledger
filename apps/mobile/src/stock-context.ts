import { createContext, useContext, useSyncExternalStore } from "react";
import type { StockQueue } from "./stock-queue";

export const StockQueueContext = createContext<StockQueue | null>(null);
export function useStockQueue() { return useContext(StockQueueContext); }
const none = () => () => undefined;
const empty: never[] = [];
/** Live queue entries, re-rendering on every status change. */
export function useQueueEntries(queue: StockQueue | null) {
  return useSyncExternalStore(queue?.subscribe ?? none, queue ? queue.getSnapshot : () => empty);
}
