import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
interface Entry { label: string; unresolved: boolean }
interface Registry { set(id: string, entry?: Entry): void; request(action: () => void): void; hasDraft(): boolean }
export const UnsavedWorkContext = createContext<Registry | null>(null);
/** Keep editable drafts in place until a user chooses to leave. No draft content is stored. */
export function useNavigationGuard(parent: Registry | null = null) {
  const entries = useRef(new Map<string, Entry>());
  const scopeId = useId();
  const approvedNavigation = useRef(false);
  const [pending, setPending] = useState<{ action(): void; labels: string[]; unresolved: boolean }>();
  const registry = useMemo<Registry>(() => ({
    set(id, entry) {
      if (entry) entries.current.set(id, entry); else entries.current.delete(id);
      parent?.set(`${scopeId}:${id}`, entry);
    },
    hasDraft() { return entries.current.size > 0; },
    request(action) {
      if (approvedNavigation.current || !entries.current.size) { action(); return; }
      const values = [...entries.current.values()];
      setPending({ action, labels: [...new Set(values.map((entry) => entry.label))], unresolved: values.some((entry) => entry.unresolved) });
    }
  }), [parent, scopeId]);
  // A supporting task keeps its own dismissal scope, but leaving the page must
  // protect it too. Remove only this scope's entries when the task closes.
  useEffect(() => () => { for (const id of entries.current.keys()) parent?.set(`${scopeId}:${id}`); }, [parent, scopeId]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!entries.current.size) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);
  return { registry, pending, cancel: () => setPending(undefined), discard: () => { if (!pending || pending.unresolved) return; setPending(undefined); approvedNavigation.current = true; try { pending.action(); } finally { approvedNavigation.current = false; } } };
}
export function useUnsavedWork(active: boolean, label: string, unresolved = false): void {
  const registry = useContext(UnsavedWorkContext), id = useId();
  useEffect(() => { registry?.set(id, active || unresolved ? { label, unresolved } : undefined); return () => registry?.set(id); }, [registry, id, active, label, unresolved]);
}
