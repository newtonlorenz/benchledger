import { useEffect, useRef, useState } from "react";
import type { InventoryItem, Project } from "./domain";
import type { WorkspaceAdapter } from "./api";
import { projectFabricationRoute, projectIntendedPrinterId } from "./project-build-readiness";
import { Button } from "./components/ui/button";

export function projectInventoryReferences(project: Project): string[] {
  const printer = projectFabricationRoute(project) === "printed" ? projectIntendedPrinterId(project) : undefined;
  return [...new Set([
    ...project.bom.flatMap((line) => [line.itemId, ...(line.alternatives ?? []).map((item) => item.itemId)]),
    ...(project.gapEvaluation?.lines ?? []).flatMap((line) => line.matchedItemIds),
    printer,
    ...(projectFabricationRoute(project) === "printed" ? [project.buildConfigSnapshot?.filamentItemId] : []),
  ].filter((id): id is string => Boolean(id)))].sort();
}

export async function loadReferencedInventory(ids: readonly string[], read: WorkspaceAdapter["readInventoryItem"], signal: AbortSignal) {
  const items: InventoryItem[] = [], failed: string[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(ids.length, 4) }, async () => {
    while (!signal.aborted && next < ids.length) {
      const id = ids[next++]!;
      try { const item = await read(id, { signal }); if (!signal.aborted) items.push(item); }
      catch { if (!signal.aborted) failed.push(id); }
    }
  }));
  return { items, failed };
}

export function useReferencedInventory(project: Project | undefined, items: InventoryItem[], read: WorkspaceAdapter["readInventoryItem"], onItems: (items: InventoryItem[]) => void) {
  const refs = project ? projectInventoryReferences(project) : [];
  const missing = refs.filter((id) => !items.some((item) => item.id === id));
  const scope = project ? `${project.id}:${project.serverRevisionId ?? project.currentRevision}` : "";
  const missingKey = JSON.stringify(missing);
  const failed = useRef({ scope: "", ids: new Set<string>() });
  const [state, setState] = useState({ scope: "", loading: false, failed: 0 });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (failed.current.scope !== scope) failed.current = { scope, ids: new Set() };
    const needed = missing.filter((id) => !failed.current.ids.has(id));
    if (!needed.length) { setState({ scope, loading: false, failed: missing.filter((id) => failed.current.ids.has(id)).length }); return; }
    let active = true;
    const controller = new AbortController();
    setState({ scope, loading: true, failed: 0 });
    void loadReferencedInventory(needed, read, controller.signal).then((result) => {
      if (!active) return;
      result.failed.forEach((id) => failed.current.ids.add(id));
      setState({ scope, loading: false, failed: missing.filter((id) => failed.current.ids.has(id)).length });
      if (result.items.length) onItems(result.items);
    });
    return () => { active = false; controller.abort(); };
  // missingKey captures the current missing IDs without restarting for unrelated item edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, missingKey, read, onItems, retry]);
  return { loading: Boolean(scope) && (state.scope !== scope ? missing.length > 0 : state.loading), failed: state.scope === scope ? state.failed : 0, retry: () => { failed.current = { scope, ids: new Set() }; setRetry((value) => value + 1); } };
}

export function ProjectInventoryStatus({ state }: { state: ReturnType<typeof useReferencedInventory> }) {
  if (state.loading) return <p role="status" className="form-hint">Loading inventory details for this project…</p>;
  if (!state.failed) return null;
  return <div role="alert" className="workflow-error"><p>{state.failed} referenced inventory {state.failed === 1 ? "item could" : "items could"} not be loaded. The recorded choices and stock results are retained; check item details before relying on them.</p><Button variant="outline" onClick={state.retry}>Retry project inventory</Button></div>;
}
