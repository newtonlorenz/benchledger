// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ReceivedStockNextStep, receiptRequirement } from "./stock-receipt";
import { inventory, projects } from "./mock-data";
afterEach(cleanup);
const project = { ...projects[0]!, serverRevisionId: "synthetic-revision" };
const context = { projectId: project.id, revisionId: project.serverRevisionId, projectName: project.name, lineId: project.bom[0]!.id, lineName: project.bom[0]!.label, unit: "each" as const };
it("continues only to the original active revision and requirement", () => {
  expect(receiptRequirement(context, project)?.id).toBe(context.lineId);
  expect(receiptRequirement(context, { ...project, serverRevisionId: "new-revision" })).toBeUndefined();
  expect(receiptRequirement(context, { ...project, status: "archived" })).toBeUndefined();
  expect(receiptRequirement(context, { ...project, bom: [] })).toBeUndefined();
  expect(receiptRequirement(context, undefined)).toBeUndefined();
});
it("keeps unconfirmed inventory distinct from counted and matched stock", () => {
  const review = vi.fn(); render(<ReceivedStockNextStep context={context} item={{ ...inventory[0]!, evidence: "delivered" }} project={project} onReview={review} />);
  expect(screen.getByText(/Confirm its physical count above/)).toBeTruthy(); expect(review).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review this item for the requirement" })); expect(review).toHaveBeenCalledOnce();
});
it("preserves the saved inventory outcome when the project revision has changed", () => {
  render(<ReceivedStockNextStep context={context} item={inventory[0]!} project={{ ...project, serverRevisionId: "new-revision" }} onReview={vi.fn()} />);
  expect(screen.queryByRole("button")).toBeNull(); expect(screen.getByText(/Your inventory item is saved/)).toBeTruthy();
});
