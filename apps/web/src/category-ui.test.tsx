import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryManager, CategorySelection, categoryTree, categoryDisplayLabel } from "./category-ui";
import type { ManagedInventoryCategory } from "./category-ui";

const categories: ManagedInventoryCategory[] = [
  { id: "category-printers", name: "Printers", sortOrder: 0, archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  { id: "category-printer-parts", name: "Printer parts", parentId: "category-printers", sortOrder: 0, archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  { id: "category-tools", name: "Tools", sortOrder: 1, archived: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 1 },
  { id: "category-archived", name: "Archived", sortOrder: 3, archived: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", version: 2 }
];

describe("managed category UI", () => {
  it("builds a deterministic one-level tree and labels child paths", () => {
    const tree = categoryTree(categories);
    expect(tree.map((node) => [node.category.id, node.children.map((child) => child.id)])).toEqual([
      ["category-printers", ["category-printer-parts"]],
      ["category-tools", []]
    ]);
    expect(categoryDisplayLabel(categories[1]!, categories[0])).toBe("Printers / Printer parts");
  });

  it("renders an accessible manager with add, rename, reorder, archive and child actions", () => {
    const markup = renderToStaticMarkup(
      <CategoryManager
        categories={categories}
        onCreate={async () => undefined}
        onUpdate={async () => undefined}
        onArchive={async () => undefined}
      />
    );
    expect(markup).toContain("Manage inventory categories");
    expect(markup).toContain("New category");
    expect(markup).toContain('aria-label="Rename Printers"');
    expect(markup).toContain("Order");
    expect(markup).not.toContain("Move Printers up");
    expect(markup).toContain('aria-label="Archive Printers"');
    expect(markup).toContain("Add subcategory");
    expect(markup).toContain("Printers / Printer parts");
    expect(markup).not.toContain("Archived");
  });

  it("marks the required selector invalid when no active category is available", () => {
    const markup = renderToStaticMarkup(<CategorySelection categories={categories.filter((category) => category.archived)} value="" onChange={() => undefined} disabled />);
    expect(markup).toContain("Category");
    expect(markup).toContain("(required)");
    expect(markup).toContain('aria-invalid="true"');
    expect(markup).toContain('disabled=""');
  });
});
