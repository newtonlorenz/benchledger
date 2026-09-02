import { describe, expect, it } from "vitest";
import { projectSetupProposalSchema } from "./schemas.js";

const proposal = (overrides: Record<string, unknown> = {}) => ({
  project: { name: "Desk sensor", status: "idea" },
  revision: { name: "Initial", status: "concept" },
  workItems: [],
  bomLines: [{ localRef: "board", name: "Controller board", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: [] }],
  reservations: [],
  ...overrides,
});

describe("project setup proposal contract", () => {
  it("accepts a bounded proposal and defaults optional collections", () => {
    const parsed = projectSetupProposalSchema.parse({
      project: { name: "Desk sensor", status: "idea" },
      revision: { name: "Initial", status: "concept" },
      bomLines: [{ localRef: "board", name: "Controller board", requiredQuantity: 1, unit: "each" }],
    });
    expect(parsed.workItems).toEqual([]);
    expect(parsed.reservations).toEqual([]);
    expect(parsed.bomLines[0]?.alternatives).toEqual([]);
  });

  it("rejects duplicate refs, unknown references, and over-limit collections", () => {
    expect(() => projectSetupProposalSchema.parse(proposal({
      workItems: [{ localRef: "same", name: "Case", kind: "part", revision: { name: "Initial", status: "concept" } }],
      bomLines: [{ localRef: "same", name: "Board", requiredQuantity: 1, unit: "each" }],
    }))).toThrow(/localRef/iu);
    expect(() => projectSetupProposalSchema.parse(proposal({
      bomLines: [{ localRef: "board", revisionLocalRef: "missing", name: "Board", requiredQuantity: 1, unit: "each" }],
    }))).toThrow(/Unknown revision localRef/iu);
    expect(() => projectSetupProposalSchema.parse(proposal({
      workItems: Array.from({ length: 7 }, (_, index) => ({ localRef: `item-${index}`, name: `Item ${index}`, kind: "part", revision: { name: "Initial", status: "concept" } })),
    }))).toThrow();
    expect(() => projectSetupProposalSchema.parse(proposal({
      project: { id: "same-id", name: "Desk sensor", status: "idea" },
      revision: { id: "same-id", name: "Initial", status: "concept" },
    }))).toThrow(/already used/iu);
  });

  it("enforces the encoded 256 KiB proposal limit", () => {
    const oversized = proposal({ bomLines: Array.from({ length: 24 }, (_, lineIndex) => ({ localRef: `board-${lineIndex}`, name: "Controller board", requiredQuantity: 1, unit: "each", optional: false, constraints: {}, alternatives: Array.from({ length: 20 }, (_, index) => ({ itemId: `item-${lineIndex}-${index}`, compatible: "conditional" as const, reason: "x".repeat(1000) })) })) });
    expect(() => projectSetupProposalSchema.parse(oversized)).toThrow(/256 KiB/iu);
  });
});
