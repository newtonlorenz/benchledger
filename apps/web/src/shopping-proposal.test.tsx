// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, act } from "@testing-library/react";
import { loadShoppingProposal, shoppingProposalText, type ProposalRow, type ProposalTotal } from "./shopping-proposal";
import { ShoppingProposal } from "./shopping-proposal-ui";
import { workflowRequest } from "./api";
import { projects } from "./mock-data";
vi.mock("./api", async original => ({ ...await original<typeof import("./api")>(), workflowRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(workflowRequest).mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const project = { ...projects[0]!, id: "proposal-project", serverRevisionId: "proposal-revision" };
const root = `/projects/${project.id}/revisions/${project.serverRevisionId}`;
const stamp = "2026-10-03T10:00:00.000Z";
function row(id: string, code = "EUR"): ProposalRow {
  return {
    line: { id, revisionId: project.serverRevisionId, name: `Synthetic ${id}`, requiredQuantity: 7, unit: "each", role: "consumed", optional: false, constraints: {}, alternatives: [], version: 1, createdAt: stamp, updatedAt: stamp },
    decision: "source", missingQuantity: 7,
    offers: [{ id: `quote-${id}`, projectId: project.id, projectRevisionId: project.serverRevisionId, bomLineId: id, bomLineVersion: 1, supplier: "Synthetic supplier", title: `Four-piece pack ${id}`, url: "https://supplier.example/parts", packageQuantity: 4, packageUnit: "each", priceMinor: 250, currency: code, taxIncluded: "unknown", observedAt: stamp, validForDays: 30, createdAt: stamp, recordedBy: "synthetic", version: 1 }],
    choice: { id: `choice-${id}`, projectId: project.id, projectRevisionId: project.serverRevisionId, bomLineId: id, offerId: `quote-${id}`, bomLineVersion: 1, version: 1, confirmedBy: "synthetic", updatedAt: stamp },
    estimate: { status: "estimated", packages: 2, partsSupplied: 8, priceMinor: 500, totalMinor: 500, currency: code, shippingKnown: false, taxIncluded: "unknown" }
  };
}
function totals(rows: ProposalRow[]): Record<string, ProposalTotal> {
  const result: Record<string, ProposalTotal> = {};
  for (const row of rows) if (row.estimate.status === "estimated") {
    const code = row.estimate.currency!, value = result[code] ?? { knownMinor: 0, shippingComplete: true, taxesComplete: true };
    value.knownMinor += row.estimate.totalMinor!; value.shippingComplete &&= row.estimate.shippingKnown; value.taxesComplete &&= row.estimate.taxIncluded === "yes"; result[code] = value;
  }
  return result;
}
const page = (rows: ProposalRow[], all = rows, nextCursor?: string) => ({ data: rows, limit: 100, total: all.length, revisionTotal: all.length, totals: totals(all), notice: "Recorded observations, not purchase authority.", ...(nextCursor === undefined ? {} : { nextCursor }) });
const options = () => ({ projectId: project.id, revisionId: project.serverRevisionId, root, signal: new AbortController().signal, now: () => new Date(stamp) });

it("reads all pages twice without carrying a visible search or filter into the proposal", async () => {
  const rows = [row("first"),row("second","USD")];
  const read = vi.fn(async (path: string) => path.includes("cursor=1") ? page(rows.slice(1),rows) : page(rows.slice(0,1),rows,"1"));
  const result = await loadShoppingProposal({ ...options(),read });
  expect(result.rows.map(row => row.line.id)).toEqual(["first","second"]);
  expect(read.mock.calls.map(([path]) => path)).toEqual([`${root}/sourcing?limit=100&filter=all`,`${root}/sourcing?limit=100&filter=all&cursor=1`,`${root}/sourcing?limit=100&filter=all`,`${root}/sourcing?limit=100&filter=all&cursor=1`]);
  const text = shoppingProposalText(result,{name:project.name,revision:"r01"});
  expect(text).toContain("2 packs supply 8 each"); expect(text).toContain("EUR"); expect(text).toContain("USD");
  expect(text).toContain("shipping incomplete"); expect(text).toContain("tax not fully confirmed"); expect(text).toContain("https://supplier.example/parts"); expect(text).toContain(`Observed: ${stamp}`); expect(text).toContain("Prepared: "+stamp);
  expect(text).toContain("Nothing is purchased, reserved, received or physically confirmed");
});
it.each(["truncated","cycle","duplicate","malformed","wrong-scope","totals"])("rejects a %s export rather than returning a partial proposal", async kind => {
  const rows = [row("first"),row("second"),row("third")];
  const read = vi.fn(async (path: string) => {
    if (kind === "truncated") return page(rows.slice(0,1),rows);
    if (kind === "cycle") return page(path.includes("cursor") ? rows.slice(1,2) : rows.slice(0,1),rows,"1");
    if (kind === "duplicate") return page(rows.slice(0,1),rows,path.includes("cursor") ? "2" : "1");
    if (kind === "malformed") return { ...page(rows), data: [{...rows[0],estimate:{status:"estimated",shippingKnown:false}}] };
    if (kind === "wrong-scope") return page([{...rows[0]!,line:{...rows[0]!.line,revisionId:"another-revision"}}]);
    return {...page(rows),totals:{EUR:{knownMinor:1,shippingComplete:false,taxesComplete:false}}};
  });
  await expect(loadShoppingProposal({...options(),read})).rejects.toThrow(/complete shopping proposal could not be verified/u);
});
it("rejects changed selected-quote evidence between verification passes even when totals stay equal", async () => {
  const first = row("first"), changed = {...first,choice:{...first.choice!,version:2}};
  const read = vi.fn().mockResolvedValueOnce(page([first])).mockResolvedValueOnce(page([changed]));
  await expect(loadShoppingProposal({...options(),read})).rejects.toThrow(/selected quotes changed/u);
});
it("propagates an interrupted read without publishing accumulated rows", async () => {
  const read = vi.fn().mockResolvedValueOnce(page([row("first")],[row("first"),row("second")],"1")).mockRejectedValueOnce(new Error("Synthetic service unavailable"));
  await expect(loadShoppingProposal({...options(),read})).rejects.toThrow("Synthetic service unavailable");
  expect(read).toHaveBeenCalledTimes(2);
});
it("aborts before continuing pagination and ignores a late completed request", async () => {
  const controller = new AbortController(); let finish!: (value: unknown) => void;
  const read = vi.fn(() => new Promise(resolve => {finish=resolve;}));
  const result = loadShoppingProposal({...options(),signal:controller.signal,read});
  controller.abort(); finish(page([row("first")]));
  await expect(result).rejects.toMatchObject({name:"AbortError"}); expect(read).toHaveBeenCalledTimes(1);
});
it("retains rejected selected quotes and missing gaps without labelling optional or ready stock as needing a quote", async () => {
  const stale = row("stale"); stale.line.version=2; stale.estimate={status:"needs_review",reason:"The requirement changed. Review the selected quote again.",shippingKnown:false};
  const missing = {...row("missing"),offers:[],choice:null,estimate:{status:"needs_review" as const,reason:"Choose a reviewed quote.",shippingKnown:false}};
  const optional={...row("optional"),line:{...row("optional").line,optional:true},estimate:{status:"needs_review" as const,reason:"Only required Source gaps enter a buying estimate.",shippingKnown:false}};
  const ready={...row("ready"),decision:"ready" as const,missingQuantity:0,estimate:optional.estimate};
  const result=await loadShoppingProposal({...options(),read:async()=>page([stale,missing,optional,ready])});
  const text=shoppingProposalText(result,{name:project.name,revision:"r01"});
  expect(result.totals).toEqual({}); expect(text).toContain("2 required requirements still need");
  expect(text).toContain("The requirement changed"); expect(text).toContain("Selected supplier observation — not included in totals"); expect(text).toContain("No supplier observation selected");
  expect(text).toContain("Optional — excluded from estimate"); expect(text).toContain("Ready — confirmed stock covers"); expect(text).not.toContain("Only required Source gaps");
});
it("presents selectable text and focuses it when clipboard access is denied", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(page([row("first")]));
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error("Denied"))}});
  render(<ShoppingProposal project={project} root={root}/>);
  fireEvent.click(screen.getByRole("button",{name:"Copy proposal"}));
  const text=await screen.findByRole("textbox",{name:"Shopping proposal text"});
  expect(document.activeElement).toBe(text); expect((text as HTMLTextAreaElement).selectionEnd).toBe((text as HTMLTextAreaElement).value.length);
  expect(screen.getByText(/Clipboard access was unavailable/u)).toBeTruthy();
  expect(screen.getByRole("button",{name:"Download proposal text"})).toBeTruthy();
  expect(vi.mocked(workflowRequest).mock.calls.every(call=>call[1]==="GET")).toBe(true);
});
it("discards a late result and cancels its transport when the revision changes", async () => {
  let finish!: (value: unknown)=>void;
  vi.mocked(workflowRequest).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const writeText=vi.fn();Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText}});
  const view=render(<ShoppingProposal project={project} root={root}/>);
  fireEvent.click(screen.getByRole("button",{name:"Copy proposal"}));
  const signal=vi.mocked(workflowRequest).mock.calls[0]?.[4]?.signal;
  view.rerender(<ShoppingProposal project={{...project,serverRevisionId:"next-revision"}} root="/next"/>);
  expect(signal?.aborted).toBe(true);
  await act(async()=>finish(page([row("first")])));
  expect(writeText).not.toHaveBeenCalled();expect(screen.queryByRole("textbox",{name:"Shopping proposal text"})).toBeNull();
});
it("invalidates previously prepared text after sourcing refreshes", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(page([row("first")]));
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn().mockRejectedValue(new Error("Denied"))}});
  const view=render(<ShoppingProposal project={project} root={root} sourceVersion={1}/>);
  fireEvent.click(screen.getByRole("button",{name:"Copy proposal"}));await screen.findByRole("textbox",{name:"Shopping proposal text"});
  view.rerender(<ShoppingProposal project={project} root={root} sourceVersion={2}/>);
  await waitFor(()=>expect(screen.queryByRole("textbox",{name:"Shopping proposal text"})).toBeNull());
});

it("downloads the verified full proposal as plain text", async () => {
  vi.mocked(workflowRequest).mockResolvedValue(page([row("first")]));
  const create=vi.fn(()=>"blob:synthetic-proposal"), revoke=vi.fn();
  vi.stubGlobal("URL",class extends URL { static override createObjectURL=create; static override revokeObjectURL=revoke; });
  const clicked=vi.spyOn(HTMLAnchorElement.prototype,"click").mockImplementation(()=>undefined);
  render(<ShoppingProposal project={project} root={root}/>);
  fireEvent.click(screen.getByRole("button",{name:"Download proposal text"}));
  await screen.findByText(/Proposal text prepared for download/u);
  expect(clicked).toHaveBeenCalledTimes(1);
  const link=clicked.mock.contexts[0] as unknown as HTMLAnchorElement;
  expect(link.download).toMatch(/^shopping-proposal-\d{4}-\d{2}-\d{2}\.txt$/u);
  expect(link.href).toBe("blob:synthetic-proposal");
  expect(create).toHaveBeenCalledWith(expect.objectContaining({type:"text/plain;charset=utf-8"}));
  expect(vi.mocked(workflowRequest)).toHaveBeenCalledTimes(2);
  await waitFor(()=>expect(revoke).toHaveBeenCalledWith("blob:synthetic-proposal"),{timeout:1500});
});
