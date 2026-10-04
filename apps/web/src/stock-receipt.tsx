import type { RequirementOffer } from "@benchledger/api-contract";
import type { InventoryItem, Project, QuantityDisplayUnit } from "./domain";
import { Button } from "./components/ui/button";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "./components/ui/disclosure";

/** Navigation context only. A quote is neither a receipt nor inventory evidence. */
export interface StockReceiptContext {
  projectId: string;
  revisionId: string;
  projectName: string;
  lineId: string;
  lineName: string;
  unit: QuantityDisplayUnit;
  quote?: RequirementOffer | undefined;
}

export function StockReceiptReference({ context }: { context: StockReceiptContext }) {
  return <section aria-label="Receiving for requirement" className="stock-receipt-context">
    <p>For <strong>{context.lineName}</strong> in {context.projectName}.</p>
    <p className="form-hint">Record what arrived. The quoted package quantity is not used as a received or counted quantity.</p>
    {context.quote && <Disclosure><DisclosureTrigger>Quote reference</DisclosureTrigger><DisclosureContent>
      <p>{context.quote.supplier} · {context.quote.title}</p>
      <p>{context.quote.packageQuantity} {context.quote.packageUnit} per quoted pack · observed {context.quote.observedAt.slice(0, 10)}</p>
      <a href={context.quote.url} target="_blank" rel="noreferrer noopener">Open recorded supplier source</a>
    </DisclosureContent></Disclosure>}
  </section>;
}

export function receiptRequirement(context: StockReceiptContext, project: Project | undefined) {
  if (!project || project.id !== context.projectId || project.serverRevisionId !== context.revisionId || project.status === "archived") return undefined;
  return project.bom.find((line) => line.id === context.lineId);
}

export function ReceivedStockNextStep({ context, item, project, onReview }: { context: StockReceiptContext; item: InventoryItem; project: Project | undefined; onReview(): void }) {
  const line = receiptRequirement(context, project);
  return <section className="stock-receipt-next-step" aria-label="Continue receiving stock">
    <h3>Continue with {context.lineName}</h3>
    <p>{item.evidence === "counted" || item.evidence === "commissioned" ? "Physical quantity recorded. Review this item against the project requirement before saving the match." : "The item is recorded. Confirm its physical count above, then review the requirement match. Unconfirmed stock will still need checking."}</p>
    {line ? <Button onClick={onReview}>Return to {context.lineName}</Button> : <p>The original requirement is no longer active in this revision. Your inventory item is saved; open the current project plan to choose where it belongs.</p>}
  </section>;
}
