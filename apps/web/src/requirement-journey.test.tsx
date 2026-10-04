// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AddBomDialog, BomLineRow, NewProjectDialog } from "./App";
import { ProjectEditingContext } from "./project-editing";
import { projectNextAction } from "./requirement-journey";
import { inventory, projects } from "./mock-data";
import type { BomInput } from "./api";
import type { BomLineStatus, InventoryItem } from "./domain";

afterEach(async () => { cleanup(); await new Promise((resolve) => setTimeout(resolve, 0)); });

it("creates a named idea without a goal or equipment decision", async () => {
  const create = vi.fn(async () => "created" as const);
  render(<NewProjectDialog onClose={() => undefined} onCreate={create} />);
  expect(screen.queryByRole("radio")).toBeNull();
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "  Synthetic sensor  " } });
  fireEvent.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "Synthetic sensor", description: "", fabricationRoute: "undecided" }));
});

it.each([["Start from a template", "template"], ["Import a parts list (CSV)", "import"]])("transfers the current idea with the selected %s path", (label, mode) => {
  const guided = vi.fn();
  render(<NewProjectDialog onClose={() => undefined} onCreate={async () => "created"} onGuided={guided} />);
  fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "Synthetic lamp" } });
  fireEvent.change(screen.getByLabelText("Project goal"), { target: { value: "Light a desk" } });
  fireEvent.click(screen.getByRole("button", { name: "Planning details" }));
  fireEvent.click(screen.getByRole("radio", { name: /Electronics \/ assembly only/u }));
  fireEvent.click(screen.getByRole("button", { name: label }));
  expect(guided).toHaveBeenCalledWith({ name: "Synthetic lamp", description: "Light a desk", fabricationRoute: "none" }, mode);
});

const spool: InventoryItem = { ...inventory.find((item) => item.category === "Filament")!, id: "synthetic-spool", name: "Synthetic PETG", variant: "Blue", location: "Test shelf", quantity: 400, availableQuantity: 350, reserved: 50, evidence: "counted", serverEvidence: "physically_counted", unit: "g", tags: [] };
it("suggests owned stock by name but saves no selection unless explicitly chosen", async () => {
  const create = vi.fn<(input: BomInput) => Promise<boolean>>().mockResolvedValue(true);
  render(<AddBomDialog items={[spool]} project={projects[0]!} expert={false} onClose={() => undefined} onCreate={create} />);
  expect(screen.queryByRole("textbox", { name: "Search matching inventory" })).toBeNull();
  expect(screen.queryByRole("textbox", { name: /Requirement note/u })).toBeNull();
  fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "PETG" } });
  const candidate = screen.getByRole("button", { name: "Choose owned item Synthetic PETG" });
  expect(candidate.getAttribute("aria-pressed")).toBe("false");
  expect(candidate.textContent).toContain("350 g available");
  expect(candidate.textContent).toContain("Physically counted");
  fireEvent.click(screen.getByRole("button", { name: "Add requirement" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "PETG", requiredQuantity: 1, unit: "each", role: "consumed" }));
});

it("keeps quantity and unit unchanged on stock selection and explicitly adopts the stock unit", async () => {
  const create = vi.fn<(input: BomInput) => Promise<boolean>>().mockResolvedValue(true);
  render(<AddBomDialog items={[spool]} project={projects[0]!} expert={false} onClose={() => undefined} onCreate={create} />);
  fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "PETG" } });
  fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "200" } });
  fireEvent.click(screen.getByRole("button", { name: "Choose owned item Synthetic PETG" }));
  expect(screen.getByLabelText("Unit")).toHaveProperty("value", "each");
  expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "200");
  expect(screen.getByRole("status").textContent).toContain("No conversion is inferred");
  fireEvent.click(screen.getByRole("button", { name: "Use grams for this requirement" }));
  expect(screen.getByLabelText("Unit")).toHaveProperty("value", "g");
  expect(screen.getByLabelText("Quantity")).toHaveProperty("value", "200");
  fireEvent.click(screen.getByRole("button", { name: "Find a different owned item" }));
  fireEvent.change(screen.getByLabelText("Search matching inventory"), { target: { value: "nothing-matches" } });
  expect(screen.getByRole("button", { name: "Choose owned item Synthetic PETG" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Add requirement" }));
  await waitFor(() => expect(create).toHaveBeenCalledWith({ name: "PETG", requiredQuantity: 200, unit: "g", role: "consumed", itemId: spool.id }));
});

it("discloses uncertain quantities instead of presenting them as available", () => {
  render(<AddBomDialog items={[{ ...spool, evidence: "delivered", serverEvidence: "delivered_uncounted" }]} project={projects[0]!} expert={false} onClose={() => undefined} onCreate={async () => true} />);
  fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "PETG" } });
  const candidate = screen.getByRole("button", { name: "Choose owned item Synthetic PETG" });
  expect(candidate.textContent).toContain("Needs a physical check");
  expect(candidate.textContent).toContain("usable quantity unconfirmed");
  expect(candidate.textContent).not.toContain("350 g available");
});

it("shows the authoritative stock reason without requiring expert mode", () => {
  const line: BomLineStatus = { line: { id: "synthetic-line", version: 1, label: "Connector", required: 1, unit: "each", role: "consumed" }, supplied: 0, remaining: 1, decision: "check", state: "inspect-first", gap: { lineId: "synthetic-line", status: "inspect_first", decision: "check", suppliedQuantity: 0, inspectQuantity: 1, missingQuantity: 0, matchedItemIds: [], reasons: ["Check the connector polarity before reuse."] } };
  render(<BomLineRow line={line} expert={false} onOpenItem={() => undefined} />);
  expect(screen.getByText("Check the connector polarity before reuse.")).toBeTruthy();
  expect(screen.queryByText("Line ID")).toBeNull();
});

it("starts an empty project with requirements and resolves stock before optional planning decisions", () => {
  const empty = { totalLines: 0, decideLines: 0, inspectLines: 0, sourceLines: 0, readinessUnavailable: false };
  expect(projectNextAction(empty, false, true, false)).toBe("requirements");
  expect(projectNextAction(empty, true, true, false)).toBe("restore");
  expect(projectNextAction({ ...empty, totalLines: 1, inspectLines: 1 }, false, true, false)).toBe("check");
  expect(projectNextAction({ ...empty, totalLines: 1, sourceLines: 1 }, false, true, false)).toBe("source");
  expect(projectNextAction({ ...empty, totalLines: 1 }, false, true, false)).toBe("approach");
});

it("discloses confirmed stock detail while keeping the requirement edit action labelled", () => {
  const line: BomLineStatus = { line: { id: "synthetic-ready", version: 1, label: "Confirmed connector", required: 1, unit: "each", role: "consumed" }, supplied: 1, remaining: 0, decision: "ready", state: "ready", gap: { lineId: "synthetic-ready", status: "supplied", decision: "ready", suppliedQuantity: 1, inspectQuantity: 0, missingQuantity: 0, matchedItemIds: [], reasons: ["A physical count confirms this connector."] } };
  const edit = vi.fn();
  render(<ProjectEditingContext.Provider value={{ project: projects[0]!, editRequirement: edit, editProject: vi.fn(), listRemoved: async () => [], restore: async () => undefined }}><BomLineRow line={line} expert={false} onOpenItem={vi.fn()} /></ProjectEditingContext.Provider>);
  const reason = screen.getByText("A physical count confirms this connector.");
  expect(reason.closest("[hidden]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Stock details" }));
  expect(reason.closest("[hidden]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Edit requirement Confirmed connector" }));
  expect(edit).toHaveBeenCalledWith(line.line);
});


it("restores focus only when returning from supporting inventory capture", async () => {
  const onAddOwnedItem = vi.fn();
  const props = { items: [], project: projects[0]!, expert: false, onClose: vi.fn(), onCreate: async () => true, onAddOwnedItem };
  const view = render(<AddBomDialog {...props} />);
  fireEvent.change(screen.getByLabelText("What do you need?"), { target: { value: "Synthetic connector" } });
  fireEvent.click(screen.getByRole("button", { name: "Add an owned item" }));
  expect(onAddOwnedItem).toHaveBeenCalledWith("Synthetic connector");
  view.rerender(<AddBomDialog {...props} suspended />);
  expect(screen.queryByRole("dialog", { name: "Add a part, material, or tool", hidden: true })).toBeNull();
  view.rerender(<AddBomDialog {...props} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Add requirement" })).toBe(document.activeElement));
  const quantity = screen.getByLabelText("Quantity"); quantity.focus();
  fireEvent.change(quantity, { target: { value: "3" } });
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(quantity).toBe(document.activeElement);
  expect(screen.getByLabelText("What do you need?")).toHaveProperty("value", "Synthetic connector");
});
