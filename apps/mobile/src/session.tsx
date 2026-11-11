import { createContext, useContext } from "react";
import type { BenchLedgerClient } from "./client";
import type { WorkspaceState } from "./session-controller";

export type Connected = Omit<WorkspaceState, "client" | "phase"> & { client: BenchLedgerClient };
export type SessionValue = Connected & { disconnect(): Promise<void>; retry(): Promise<void> };
export const SessionContext = createContext<SessionValue | null>(null);
export function useSession() {
  const context = useContext(SessionContext);
  if (!context) throw new Error("A connected server is required");
  return context;
}
