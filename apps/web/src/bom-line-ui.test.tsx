import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BomLineRow } from "./App";
import { mapBomLine } from "./api";
import type { BomLineStatus } from "./domain";

describe("BOM line version and expert context", () => {
  it("maps the server BOM line version exactly and retains the canonical unit", () => {
    const line = mapBomLine({
      id: "bom-line-42",
      revisionId: "revision-7",
      name: "PETG",
      requiredQuantity: 400,
      unit: "gram",
      optional: false,
      constraints: {},
      alternatives: [],
      createdAt: "2026-09-02T10:00:00.000Z",
      updatedAt: "2026-09-02T10:00:00.000Z",
      version: 42
    });

    expect(line).toMatchObject({ id: "bom-line-42", version: 42, unit: "g", serverUnit: "gram" });
  });

  it("keeps line identity, version, and canonical unit inside the expert-only disclosure", () => {
    const status: BomLineStatus = {
      line: { id: "bom-line-42", version: 7, label: "PETG", required: 400, unit: "g", serverUnit: "gram" },
      supplied: 0,
      remaining: 400,
      state: "missing",
      decision: "source"
    };
    const props = { line: status, onOpenItem: () => undefined };

    const expertMarkup = renderToStaticMarkup(<BomLineRow {...props} expert />);
    expect(expertMarkup).toContain("<span>Line ID</span><p>bom-line-42</p>");
    expect(expertMarkup).toContain("<span>Line version</span><p>7</p>");
    expect(expertMarkup).toContain("<span>Canonical unit</span><p>gram</p>");

    const beginnerMarkup = renderToStaticMarkup(<BomLineRow {...props} expert={false} />);
    expect(beginnerMarkup).not.toContain("bom-expert");
    expect(beginnerMarkup).not.toContain("Line ID");
    expect(beginnerMarkup).not.toContain("Line version");
    expect(beginnerMarkup).not.toContain("Canonical unit");
  });
});
