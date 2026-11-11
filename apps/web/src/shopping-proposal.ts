import { bomLineSchema, offerChoiceSchema, requirementOfferSchema } from "@benchledger/api-contract";
import type { BomLine, OfferChoice, RequirementOffer, RequirementOfferEstimate } from "@benchledger/api-contract";
import { workflowRequest } from "./api";
import { quotedMoney } from "./workflow-ui";

export interface ProposalRow { line: BomLine; decision: "ready" | "check" | "decide" | "source"; missingQuantity: number; offers: RequirementOffer[]; choice: OfferChoice | null; estimate: RequirementOfferEstimate }
export interface ProposalTotal { knownMinor: number; shippingComplete: boolean; taxesComplete: boolean }
export interface ShoppingProposalSnapshot { rows: ProposalRow[]; totals: Record<string, ProposalTotal>; preparedAt: string }
export type ProposalRead = (path: string, signal: AbortSignal) => Promise<unknown>;
const pageSize = 100;
const maximumPages = 100;
const invalid = () => new Error("The complete shopping proposal could not be verified. Refresh supplier quotes and try again; no partial proposal was prepared.");
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const quantity = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown): value is number => quantity(value) && Number.isSafeInteger(value);
const currency = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/u.test(value);
function checked<T>(value: T | undefined): T { if (value === undefined) throw invalid(); return value; }

function parseEstimate(value: unknown): RequirementOfferEstimate {
  const source = checked(record(value));
  if (!["estimated", "needs_review"].includes(String(source.status)) || typeof source.shippingKnown !== "boolean" || source.reason !== undefined && typeof source.reason !== "string") throw invalid();
  for (const field of ["packages", "priceMinor", "shippingMinor", "totalMinor"]) if (source[field] !== undefined && !integer(source[field])) throw invalid();
  if (source.partsSupplied !== undefined && !quantity(source.partsSupplied) || source.currency !== undefined && !currency(source.currency) || source.taxIncluded !== undefined && !["yes", "no", "unknown"].includes(String(source.taxIncluded))) throw invalid();
  if (source.status === "estimated" && (!integer(source.packages) || source.packages < 1 || !quantity(source.partsSupplied) || !integer(source.priceMinor) || !integer(source.totalMinor) || !currency(source.currency) || source.taxIncluded === undefined)) throw invalid();
  return source as unknown as RequirementOfferEstimate;
}
function parsePage(value: unknown, projectId: string, revisionId: string) {
  const source = checked(record(value));
  if (!Array.isArray(source.data) || source.data.length > pageSize || !integer(source.total) || !integer(source.revisionTotal) || source.total !== source.revisionTotal || source.limit !== pageSize || typeof source.notice !== "string") throw invalid();
  if (source.nextCursor !== undefined && (typeof source.nextCursor !== "string" || !/^(0|[1-9][0-9]*)$/u.test(source.nextCursor) || source.nextCursor.length > 12)) throw invalid();
  const totals: Record<string, ProposalTotal> = {};
  for (const [code, value] of Object.entries(checked(record(source.totals)))) {
    const total = checked(record(value));
    if (!currency(code) || !integer(total.knownMinor) || typeof total.shippingComplete !== "boolean" || typeof total.taxesComplete !== "boolean") throw invalid();
    totals[code] = { knownMinor: total.knownMinor, shippingComplete: total.shippingComplete, taxesComplete: total.taxesComplete };
  }
  const rows = source.data.map((entry): ProposalRow => {
    const row = checked(record(entry));
    const line = bomLineSchema.safeParse(row.line), offers = requirementOfferSchema.array().safeParse(row.offers), choice = offerChoiceSchema.nullable().safeParse(row.choice);
    if (!line.success || !offers.success || !choice.success || line.data.revisionId !== revisionId || line.data.retiredAt || !["ready", "check", "decide", "source"].includes(String(row.decision)) || !quantity(row.missingQuantity)) throw invalid();
    if (offers.data.some(offer => offer.projectId !== projectId || offer.projectRevisionId !== revisionId || offer.bomLineId !== line.data.id) || new Set(offers.data.map(offer => offer.id)).size !== offers.data.length) throw invalid();
    if (choice.data && (choice.data.projectId !== projectId || choice.data.projectRevisionId !== revisionId || choice.data.bomLineId !== line.data.id)) throw invalid();
    const estimate = parseEstimate(row.estimate), selected = offers.data.find(offer => offer.id === choice.data?.offerId);
    if (estimate.status === "estimated" && (!selected || line.data.optional || row.decision !== "source" || row.missingQuantity <= 0 || choice.data?.bomLineVersion !== line.data.version || selected.packageUnit !== line.data.unit || estimate.currency !== selected.currency || estimate.partsSupplied! < row.missingQuantity)) throw invalid();
    return { line: line.data, offers: offers.data, choice: choice.data, decision: row.decision as ProposalRow["decision"], missingQuantity: row.missingQuantity, estimate };
  });
  return { rows, totals, total: source.total, nextCursor: source.nextCursor as string | undefined };
}
const fingerprint = (value: { rows: ProposalRow[]; totals: Record<string, ProposalTotal> }) => JSON.stringify({ rows: [...value.rows].sort((a,b) => a.line.id.localeCompare(b.line.id)), totals: Object.entries(value.totals).sort(([a],[b]) => a.localeCompare(b)) });

/** Reads every page twice: the endpoint is read-committed, not an atomic export snapshot. */
export async function loadShoppingProposal({ projectId, revisionId, root, signal, read = (path, signal) => workflowRequest(path, "GET", undefined, undefined, { signal }), now = () => new Date() }: { projectId: string; revisionId: string; root: string; signal: AbortSignal; read?: ProposalRead; now?: () => Date }): Promise<ShoppingProposalSnapshot> {
  const pass = async () => {
    const rows: ProposalRow[] = [], ids = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined, expected: ReturnType<typeof parsePage> | undefined;
    for (let pageNumber = 0; pageNumber < maximumPages; pageNumber += 1) {
      signal.throwIfAborted();
      const parameters = new URLSearchParams({ limit: String(pageSize), filter: "all", ...(cursor === undefined ? {} : { cursor }) });
      const page = parsePage(await read(`${root}/sourcing?${parameters}`, signal), projectId, revisionId);
      signal.throwIfAborted();
      expected ??= page;
      if (page.total !== expected.total || JSON.stringify(Object.entries(page.totals).sort()) !== JSON.stringify(Object.entries(expected.totals).sort())) throw new Error("The requirements or quote totals changed while preparing the proposal. Refresh supplier quotes and try again.");
      for (const row of page.rows) { if (ids.has(row.line.id)) throw invalid(); ids.add(row.line.id); rows.push(row); }
      if (rows.length > page.total) throw invalid();
      if (page.nextCursor === undefined) {
        if (rows.length !== page.total) throw invalid();
        const computed: Record<string, ProposalTotal> = {};
        for (const row of rows) if (row.estimate.status === "estimated") {
          const estimate = row.estimate, code = estimate.currency!;
          const total = computed[code] ?? { knownMinor: 0, shippingComplete: true, taxesComplete: true };
          total.knownMinor += estimate.totalMinor!; total.shippingComplete &&= estimate.shippingKnown; total.taxesComplete &&= estimate.taxIncluded === "yes";
          if (!integer(total.knownMinor)) throw invalid(); computed[code] = total;
        }
        if (JSON.stringify(Object.entries(computed).sort()) !== JSON.stringify(Object.entries(page.totals).sort())) throw invalid();
        return { rows, totals: page.totals };
      }
      if (!page.rows.length || cursors.has(page.nextCursor) || Number(page.nextCursor) <= Number(cursor ?? "0") || Number(page.nextCursor) !== rows.length || rows.length >= page.total) throw invalid();
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    throw new Error("This revision exceeds the proposal export limit of 10,000 requirements. No partial proposal was prepared.");
  };
  const first = await pass(), verified = await pass();
  signal.throwIfAborted();
  if (fingerprint(first) !== fingerprint(verified)) throw new Error("The requirements or selected quotes changed while preparing the proposal. Refresh supplier quotes and try again.");
  return { ...verified, preparedAt: now().toISOString() };
}

const textLine = (text: string) => text.replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
const amount = (minor: number, code: string) => `${quotedMoney(minor, code)} ${code}`;
export function shoppingProposalText(snapshot: ShoppingProposalSnapshot, project: { name: string; revision: string }): string {
  const unresolved = snapshot.rows.filter(row => !row.line.optional && (row.decision === "check" || row.decision === "decide" || row.decision === "source" && row.estimate.status !== "estimated"));
  const lines = ["BenchLedger shopping proposal", `Project: ${textLine(project.name)}`, `Revision: ${textLine(project.revision)}`, `Prepared: ${snapshot.preparedAt}`, `${snapshot.rows.length} requirements in the full revision; ${unresolved.length} required requirements still need checking, a decision or a current selected quote.`, "", "Dated snapshot, checked twice while preparing. The workspace can change; refresh and review before ordering.", "Supplier observations are recorded prices, not live offers or purchase authority. Nothing is purchased, reserved, received or physically confirmed by this proposal. Check owned stock and fit before sourcing; confirm received quantities separately.", "", "Known selected-quote totals (currencies kept separate):"];
  const totals = Object.entries(snapshot.totals).sort(([a],[b]) => a.localeCompare(b));
  if (!totals.length) lines.push("No current selected quotes contribute to the estimate.");
  for (const [code,total] of totals) lines.push(`${amount(total.knownMinor, code)} — ${total.shippingComplete ? "recorded shipping included" : "shipping incomplete"}; ${total.taxesComplete ? "tax included" : "tax not fully confirmed"}.`);
  lines.push("Shipping is recorded separately per quote; combined supplier shipping is not inferred.", "");
  snapshot.rows.forEach((row,index) => {
    const { line, estimate } = row;
    const status = line.optional ? "Optional — excluded from estimate" : row.decision === "ready" ? "Ready — confirmed stock covers the requirement" : row.decision === "check" ? "Check owned stock or compatibility before sourcing" : row.decision === "decide" ? "Resolve the requirement before sourcing" : estimate.status === "estimated" ? "Source — selected quote estimated" : "Source — needs a current reviewed quote";
    lines.push(`${index + 1}. ${textLine(line.name)}`, `   ${status}`, `   Required: ${line.requiredQuantity} ${line.unit}; unfilled: ${row.missingQuantity} ${line.unit}.`);
    if (line.notes) lines.push(`   Requirement note: ${textLine(line.notes)}`);
    if (!line.optional && row.decision === "source" && estimate.status !== "estimated") lines.push(`   Review needed: ${textLine(estimate.reason ?? "Select a current quote after checking fit.")}`);
    const quote = row.offers.find(offer => offer.id === row.choice?.offerId);
    if (quote) {
      lines.push(`   Selected supplier observation${estimate.status !== "estimated" ? " — not included in totals" : ""}: ${textLine(quote.supplier)} — ${textLine(quote.title)}`, `   Package: ${quote.packageQuantity} ${quote.packageUnit}; package price: ${amount(quote.priceMinor, quote.currency)}.`, `   Shipping: ${quote.shippingMinor === undefined ? "not recorded" : amount(quote.shippingMinor, quote.currency)}; tax included: ${quote.taxIncluded}.`, `   Source: ${textLine(quote.url)}`, `   Observed: ${quote.observedAt}; review after ${quote.validForDays} days.`);
      if (estimate.status === "estimated") lines.push(`   Estimated: ${estimate.packages} packs supply ${estimate.partsSupplied} ${line.unit}; known cost ${amount(estimate.totalMinor!, estimate.currency!)}.`);
      if (quote.notes) lines.push(`   Quote note: ${textLine(quote.notes)}`);
    } else if (row.choice?.offerId) lines.push("   The selected supplier observation is unavailable; review it before sourcing.");
    else if (!line.optional && row.decision === "source") lines.push("   No supplier observation selected.");
    lines.push("");
  });
  return lines.join("\n");
}
