// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useState } from "react";
import { inventory, projects } from "./mock-data";
import type { InventoryItem, Project } from "./domain";
import type { WorkspaceAdapter } from "./api";
import { loadReferencedInventory, ProjectInventoryStatus, useReferencedInventory, projectInventoryReferences } from "./project-referenced-inventory";
afterEach(cleanup);
const item = { ...inventory[0]!, id: "synthetic-remote", name: "Synthetic remote stock" };
const project: Project = { ...projects[0]!, bom: [{ ...projects[0]!.bom[0]!, itemId: item.id, alternatives: [] }] , fabricationRoute: "none" as const };
delete project.gapEvaluation; delete project.buildConfigSnapshot;
it("loads only referenced identities with at most four requests and stops scheduling on abort", async () => {
  const controller = new AbortController();
  const pending: (() => void)[] = [];
  const read = vi.fn<WorkspaceAdapter["readInventoryItem"]>((id) => new Promise((resolve) => pending.push(() => resolve({ ...item, id }))));
  const result = loadReferencedInventory(["a", "b", "c", "d", "e", "f"], read, controller.signal);
  expect(read).toHaveBeenCalledTimes(4);
  controller.abort(); pending.forEach((resolve) => resolve());
  expect(await result).toEqual({ items: [], failed: [] });
  expect(read).toHaveBeenCalledTimes(4);
});
it("deduplicates explicit and alternative inventory references without scanning unrelated inventory", () => {
  expect(projectInventoryReferences({ ...project, bom: [{ ...project.bom[0]!, alternatives: [{ itemId: "synthetic-alternative", compatible: "unknown" as const }] }] })).toEqual(["synthetic-alternative", item.id]);
});
function Harness({ read }: { read: WorkspaceAdapter["readInventoryItem"] }) {
  const [items, setItems] = useState<InventoryItem[]>([]);
  const merge = useCallback((loaded: InventoryItem[]) => setItems((existing) => [...existing, ...loaded]), []);
  const state = useReferencedInventory(project, items, read, merge);
  return <><ProjectInventoryStatus state={state}/>{items.map((entry) => <p key={entry.id}>{entry.name}</p>)}</>;
}
it("retains an explicit failed state without retry loops, then restores details on deliberate retry", async () => {
  const read = vi.fn<WorkspaceAdapter["readInventoryItem"]>().mockRejectedValueOnce(new Error("Synthetic unavailable")).mockResolvedValueOnce(item);
  render(<Harness read={read}/>);
  expect(screen.getByRole("status").textContent).toContain("Loading inventory details");
  expect((await screen.findByRole("alert")).textContent).toContain("recorded choices and stock results are retained");
  expect(read).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry project inventory" }));
  await screen.findByText(item.name);
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(read).toHaveBeenCalledTimes(2);
});
