# Stock and evidence semantics

BenchLedger treats inventory as an evidence-backed ledger. A row that says an
item was ordered is not the same fact as a counted, usable item on the shelf.
The distinction is what lets an agent make a useful recommendation without
overpromising.

## Stock receiving policy

Each workspace answers one question in **Settings → When does stock count as
in stock?** The answer is the `stockReceivingPolicy` workspace preference:

| Policy | Label | Ordered (`ordered_unverified`) | Delivered (`delivered_uncounted`) | Counted / commissioned |
| --- | --- | --- | --- | --- |
| `on_purchase` | When it's bought | In stock (assumed) | In stock (assumed) | In stock |
| `on_delivery` | When it's delivered | Pending (`ordered`) | In stock (assumed) | In stock |
| `on_receipt` (default) | When I've received and checked it | Pending (`ordered`) | Pending (`inspect_first`) | In stock |

`on_receipt` is the historical behaviour and the default. Choose it to manage
delivered and received stock separately: ordered and delivered stock stay
pending until a receiving count or commissioning confirms them.

The policy **never rewrites stored evidence**. It is an explicit input to the
domain classifier (`classifyEvidenceAvailability(state, policy)` in
`packages/domain/src/evidence.ts`), and every derived view reads it per
operation: BOM supply eligibility, reservation eligibility, available
quantities, gap evaluation and readiness, shopping proposals, the
inspect-first queue and project setup previews. Stock that counts only because
of the policy is reported as `assumed`, and every surface keeps the recorded
evidence beside it (for example “In stock · delivered, not counted”).

Changing the policy is a human workspace-administrator decision: an unscoped
browser session (`PUT /api/v1/workspace/preferences`) with optimistic
versioning (`If-Match` or `expectedVersion`) and an audit row recording the
actor and `from`/`to`. Every authenticated caller can read it
(`GET /api/v1/workspace/preferences`, the `/workspace` snapshot,
`refresh_context` and `read_inventory_summary`). MCP has no tool to change it.
`GET /api/v1/workspace/preferences/stock-receiving-impact` previews which rows
start or stop counting. A change that would make reserved stock stop counting
is refused (`409 policy_change_strands_reservations`) until those rows are
counted or their reservations are released.

The ledger starts a delivered or ordered row from its recorded (claimed)
quantity, so policy-trusted stock can be reserved and used. That baseline is
not counted evidence; a receiving count replaces it and records the replaced
claim as `claimedBaseline` in the append-only count event.

## Availability states

| Availability | Meaning | Eligible for automatic BOM supply and reservation? | Human action |
| --- | --- | --- | --- |
| `confirmed` | Physical count or commissioning evidence supports current usable quantity | Yes, when unit, compatibility, condition, and quantity match | None unless the project is safety-relevant |
| `assumed` | Delivery or order evidence that the workspace receiving policy trusts | Yes, as for `confirmed`; the evidence stays uncounted | Count it when it arrives to record receipt |
| `inspect_first` | A plausible item exists, but current quantity, condition, or identity needs checking (includes delivered stock under `on_receipt`) | No | Count/inspect, then record a compensating stock event |
| `ordered` | Order evidence only, not trusted by the policy | No | Wait for delivery, then count |
| `unknown` | No usable evidence | No | Record a count or evidence |

Stored evidence states remain `physically_counted`, `commissioned`,
`delivered_uncounted`, `ordered_unverified`, `allocated`, `consumed` and
`unknown`. Allocated stock is usable only for its reservation/project; depleted
rows have no usable amount; retired rows keep their history.

MCP outputs report the stored canonical evidence state exactly
(`physically_counted`, `commissioned`, `delivered_uncounted`,
`ordered_unverified`, `allocated`, `consumed`, `unknown`) alongside the derived
availability above; legacy input labels (`physical_count`, `delivery`, `order`)
are accepted, and non-observations (`measured`, `manufacturer`,
`user_reported`, `inferred`) store `unknown`. Stock events report only the
evidence they actually recorded. The adapter never upgrades an uncertain state
simply because a BOM line mentions the same name.

Every MCP inventory row keeps three quantities distinct: total on-hand,
currently available, and currently allocated. When allocation is present it
reconciles exactly as `allocated = on-hand - available`. A fully allocated row
is not depleted, and a partially allocated row exposes both remaining and held
stock. Summary availability buckets are mutually exclusive, while the separate
confirmed-evidence, available-confirmed, and allocated-quantity figures remain
derivable from the same returned rows. Retired rows do not contribute available
or allocated quantities.

## Evidence hierarchy

Prefer, in order:

1. A dated physical count, measured interface, or exact-machine commissioning
   record.
2. A manufacturer drawing, datasheet, printer manual, or controlled local test.
3. A dated user report or project observation.
4. An order, shipment, delivery, or price observation.
5. An inference or name-only match.

Every recommendation should identify the source and age of the evidence. A
nominal dimension is not silently presented as a measured fit. A supplier price
is an observation with a timestamp and currency, not a guaranteed checkout total.

## Stock events

Inventory quantity is changed through an append-only event such as:

```text
receipt / count_correction / allocation / return / use / loss / disposal
```

The event records actor, time, quantity and evidence or reason. A correction is
preferred over editing history. If a human finds fewer parts than the ledger
claims, record the observed count/correction and retain the prior event. A
reservation is not consumption; actual consumption is recorded separately with
`record_usage`.

An uncertain `delivered_uncounted` or `ordered_unverified` item is received
in one of three ways, each appending a count event that keeps the prior
evidence in its audit payload:

- **Receiving count** (`POST /inventory/{id}/count`, the browser's “Receive and
  count”): a physical count of delivered or ordered stock is what receiving
  means. It records `physically_counted` evidence and is audited as received
  (`received: true`, evidence from/to). This is the same under every policy.
- **Commissioning** (`commission_inventory_item`): requires a current version,
  an observed quantity, and commissioned provenance (source and observation
  time), and records `commissioned` evidence.
- **A confirmed inspection completion.**

Generic metadata PATCH cannot change evidence. A generic `count_correction`
stock event adjusts already-counted stock but never makes uncertain stock
counted, and other generic stock movements (receipt, correction, loss and so
on) are refused for delivered or ordered rows until they are received, because
they would silently move the claimed quantity. Reservations and project usage
of policy-trusted stock use their own audited paths.

## BOM evaluation

For each line, the service considers the exact item, explicit alternatives, unit,
declared constraints, dimensions, machine/process requirements, condition, and
stock state. The response must include:

- requested and supplied quantities in canonical units;
- candidate item IDs and compatibility reasons;
- whether the candidate is confirmed, assumed under the receiving policy, or
  inspect-first, together with its unchanged stored evidence state;
- shortfall, the Ready/Check/Decide/Source decision, and recommended action
  (`reuse`, `inspect`, `specify`, `buy`, or `none`);
- the evidence that caused the classification.

Required readiness totals exclude optional lines in every outcome state.
Optionality remains a separate flag and total, so a supplied optional line does
not inflate the required supplied count.

An insufficient requirement is `specify_first` / Decide, not missing stock. Its
`missingDecisions` identify the unanswered identity, purpose, electrical,
connector, compatibility, dimensional, resistance, or power-rating choices.
Power-supply requirements must at least resolve current/load and connector
before Source is permitted. LED resistor requirements must resolve both
resistance and power rating before Source is permitted. A sufficient marker with
only one of those resistor decisions is still incomplete.
If a plausible recorded item still needs a count or compatibility decision,
Check takes precedence so the existing item can be inspected before shopping.
A known shortfall after confirmed partial coverage is Source for the remaining
quantity unless an inspect-first candidate could cover it.

### Canonical quantities and package conversions

Readiness and reservations use the server's canonical units: `each`, `gram`,
`millimetre`, `millilitre`, `metre`, and `set`. Beginner web aliases such as
`g` and `m` are display-only; a `set` remains a `set` in mapped inventory, BOM,
gap, and reservation data. A structured alternative may carry an evidence-backed
nested conversion with package quantity, requirement quantity, evidence basis,
observation time, and optional source details. Only a valid whole-set conversion
whose units match the canonical contract may contribute capacity. Candidate
reasons retain honest package capacity, allocation, and whole-unit overage.

Missing, malformed, or unit-mismatched conversions are never inferred from a
name or display label. Connected web readiness consumes the canonical server gap
status and shows an explicit mismatch or conversion diagnostic; offline/sample
fallback uses the shared resolver and fails closed. These candidates remain
Check until evidence and compatibility are confirmed.

This conversion rule is separate from the semantic unit policy for inventory
items. New creates use a lightweight default by kind (`each` for printers,
tools, accessories, electronics, fasteners, consumables, and `other`; `gram`
for filament; `metre` for wire; `millilitre` for adhesive) and reject an
incompatible kind/unit pair. Older rows are not rewritten: reads expose
`unitStatus: "needs_correction"` and a reason while preserving their quantity,
evidence, and provenance. Such rows are excluded from confident matching,
reservation, usage, project setup, and reconciliation until corrected through
an explicit evidence-bearing workflow.

In-stock quantity (confirmed, or assumed under the receiving policy) is
consumed by allocation arithmetic, so two projects cannot silently reserve the
same available quantity. If no in-stock candidate covers a fully specified
required line, the agent may prepare a shopping proposal. It must not reserve
stock the policy does not count merely to make the gap disappear, and it must
not change the policy (that is a human Settings decision).

## Shopping-list semantics

Shopping output is a proposal composed from BOM gaps and offer observations:

Only required Source lines are eligible for shopping. Ready, Check,
`specify_first`/Decide, and optional lines are excluded from shopping rows,
counts, totals, and copied draft lists. This avoids proposing a purchase before
required characteristics have been decided or while plausible stock still needs
inspection. If no required Source line exists but Decide or Check work remains,
the UI says “Nothing is ready to source” and explains the blockers instead of
claiming that inventory covers everything.

Within an eligible Source line, alternative-linked offers are included only for
exact or `confirmed_alternative` candidates returned by canonical readiness.
Conditional, uncertain, unknown, and unit-mismatch candidates never add an offer
to the proposal.

Show package rounding, observed price, currency, shipping when known, link, and
price age. Never claim that the offer is current without a fresh observation.
The `record_offer_snapshot` tool stores a supplied observation; it does not
retrieve the URL, add to a cart, or place an order.
