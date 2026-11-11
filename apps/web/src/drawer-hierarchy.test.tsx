import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InventoryDrawer, projectsUsingItem } from "./App";
import { inventory, projects } from "./mock-data";

describe("inventory drawer hierarchy", () => {
  const item = inventory[0]!;
  const render = (extra: Record<string, unknown> = {}) => renderToStaticMarkup(<InventoryDrawer item={item} categories={[]} categoriesLoading={false} expert={false} onClose={() => undefined} onCount={async () => item} onCommission={async () => item} onUpdate={async () => item} onDelete={async () => undefined} {...extra} />);

  it("leads with quantity on hand, status and location before images", () => {
    const markup = render();
    const summary = markup.indexOf("drawer-summary");
    expect(summary).toBeGreaterThan(-1);
    expect(markup).toContain("On hand");
    expect(summary).toBeLessThan(markup.indexOf("inventory-images"));
  });

  it("keeps Delete away from Edit, after the stock check", () => {
    const markup = render();
    const edit = markup.indexOf("Edit item");
    const count = markup.indexOf("physical-count-heading");
    const remove = markup.indexOf(item.kind === "printer" ? "Delete printer" : "Delete item");
    expect(edit).toBeGreaterThan(-1);
    expect(remove).toBeGreaterThan(count);
  });

  it("lists the projects that use the item when known", () => {
    const base = projects[0]!;
    const linked = { ...base, id: "linked", name: "Linked", bom: [{ ...base.bom[0]!, itemId: item.id }] };
    const archived = { ...linked, id: "old", name: "Old", status: "archived" as const };
    const unrelated = { ...base, id: "other", name: "Other", bom: [] };
    expect(projectsUsingItem([linked, archived, unrelated], item.id)).toEqual([{ id: "linked", name: "Linked" }]);
    const markup = render({ usedIn: [{ id: "p1", name: "Desk lamp" }] });
    expect(markup).toContain("Used in projects");
    expect(markup).toContain("Desk lamp");
  });
});
