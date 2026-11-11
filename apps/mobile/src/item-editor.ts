import { useCallback, useEffect, useRef, useState } from "react";
import type { InventoryItem } from "@benchledger/api-contract";
import type { InventoryEdit } from "./client";
import { ClientError, errorMessage } from "./connection";

export type EditorClient = {
  item(id: string): Promise<InventoryItem>;
  updateItem(item: InventoryItem, input: InventoryEdit, key: string): Promise<InventoryItem>;
};
export const editFromItem = (item: InventoryItem): InventoryEdit => ({ name: item.name, location: item.location ?? "", description: item.description ?? "" });
const same = (a: InventoryEdit, b: InventoryEdit) => a.name === b.name && a.location === b.location && a.description === b.description;
const editFields = ["name", "location", "description"] as const;
export type EditField = typeof editFields[number];
export type FieldConflict = { field: EditField; mine: string; theirs: string };

/**
 * Three-way merge of an edit onto the latest server record: fields the user
 * did not touch take the latest values; fields only the user changed keep the
 * user's value; fields both sides changed differently are conflicts.
 */
export function mergeEdit(started: InventoryEdit, mine: InventoryEdit, latest: InventoryEdit): { merged: InventoryEdit; conflicts: FieldConflict[] } {
  const merged = { ...latest };
  const conflicts: FieldConflict[] = [];
  for (const field of editFields) {
    if (mine[field] === started[field]) continue;
    if (latest[field] !== started[field] && latest[field] !== mine[field]) conflicts.push({ field, mine: mine[field], theirs: latest[field] });
    merged[field] = mine[field];
  }
  return { merged, conflicts };
}

/**
 * Edit form state bound to the server's current version. On a 409 the latest
 * record is fetched so the user can retry their own changes against it
 * (choosing per field where both sides changed the same field) or discard.
 */
export function useItemEditor(client: EditorClient, id: string, keyFor: (input: unknown) => string) {
  const [base, setBase] = useState<InventoryItem>();
  const [input, setInput] = useState<InventoryEdit>();
  // The values the user started editing from; the merge base on a conflict.
  const [started, setStarted] = useState<InventoryEdit>();
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<InventoryItem>();
  const [choices, setChoices] = useState<Partial<Record<EditField, "mine" | "theirs">>>({});
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false);
  const load = useCallback(async () => {
    setLoadError("");
    try {
      const item = await client.item(id); setBase(item);
      setInput((old) => old ?? editFromItem(item)); setStarted((old) => old ?? editFromItem(item));
    } catch (e) { setLoadError(errorMessage(e)); }
  }, [client, id]);
  useEffect(() => { void load(); }, [load]);
  const save = useCallback(async (against = base, values = input) => {
    if (inFlight.current || !against || !values) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await client.updateItem(against, values, keyFor({ values, version: against.version })); setSaved(true); }
    catch (e) {
      if (e instanceof ClientError && e.status === 409) {
        try { setConflict(await client.item(id)); setChoices({}); setError("This item changed on the server while you were editing."); }
        catch (reload) { setError(`${errorMessage(e)} ${errorMessage(reload)}`); }
      } else setError(errorMessage(e));
    } finally { setBusy(false); inFlight.current = false; }
  }, [base, input, client, id, keyFor]);
  const fieldConflicts = conflict && started && input ? mergeEdit(started, input, editFromItem(conflict)).conflicts : [];
  const choose = useCallback((field: EditField, side: "mine" | "theirs") => setChoices((old) => ({ ...old, [field]: side })), []);
  const keepMine = useCallback(async () => {
    if (!conflict || !started || !input) return;
    const latest = editFromItem(conflict);
    const { merged, conflicts } = mergeEdit(started, input, latest);
    const unresolved = conflicts.filter((entry) => choices[entry.field] === undefined);
    if (unresolved.length > 0) { setError(`Choose which value to keep for: ${unresolved.map((entry) => entry.field).join(", ")}.`); return; }
    for (const entry of conflicts) merged[entry.field] = choices[entry.field] === "theirs" ? entry.theirs : entry.mine;
    // The latest record is now the merge base for any further conflict.
    setBase(conflict); setStarted(latest); setInput(merged); setConflict(undefined); setChoices({});
    await save(conflict, merged);
  }, [conflict, started, input, choices, save]);
  const discard = useCallback(() => {
    if (!conflict) return;
    setBase(conflict); setInput(editFromItem(conflict)); setStarted(editFromItem(conflict)); setConflict(undefined); setChoices({}); setError("");
  }, [conflict]);
  const change = useCallback((patch: Partial<InventoryEdit>) => setInput((old) => old && { ...old, ...patch }), []);
  const dirty = !!base && !!input && !same(input, editFromItem(base));
  return { base, input, loadError, reload: load, busy, error, conflict, fieldConflicts, choices, choose, saved, dirty, change, save: () => save(), keepMine, discard };
}
