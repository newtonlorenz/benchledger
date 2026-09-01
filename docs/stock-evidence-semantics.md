# Stock and evidence semantics

BenchLedger treats inventory as an evidence-backed ledger. A row that says an
item was ordered is not the same fact as a counted, usable item on the shelf.
The distinction is what lets an agent make a useful recommendation without
overpromising.

## Availability states

| State | Meaning | Eligible for automatic BOM supply? | Human action |
| --- | --- | --- | --- |
| `confirmed` | Physical count or commissioning evidence supports current usable quantity | Yes, when unit, compatibility, condition, and quantity match | None unless the project is safety-relevant |
| `inspect_first` | A plausible item exists, but current quantity, condition, or identity needs checking | No | Count/inspect, then record a compensating stock event |
| `delivered_uncounted` | Delivery evidence says it arrived; no current count | No | Locate and count |
| `ordered_unverified` | Order evidence says it was purchased or shipped | No | Wait for delivery, then count |
| `allocated` | Confirmed stock is reserved or assigned to a project | Only for that reservation/project | Release or record usage |
| `depleted` | Ledger says no usable amount remains | No | Receive/count new stock |
| `retired` | Logical record is no longer active | No | Preserve history; create a replacement record if needed |

The domain may expose additional source-specific evidence labels, but the MCP
adapter maps them to the plain-language states above. It never upgrades an
uncertain state simply because a BOM line mentions the same name.

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

An uncertain `delivered_uncounted` or `ordered_unverified` item can become
`commissioned` only through the explicit commissioning command. The command
requires a current version, an observed quantity, and commissioned provenance
(source and observation time). It appends a count event that keeps the prior
evidence in its audit payload; generic metadata PATCH cannot change evidence.

## BOM evaluation

For each line, the service considers the exact item, explicit alternatives, unit,
declared constraints, dimensions, machine/process requirements, condition, and
stock state. The response must include:

- requested and supplied quantities in canonical units;
- candidate item IDs and compatibility reasons;
- whether the candidate is confirmed or inspect-first;
- shortfall, the Ready/Check/Decide/Source decision, and recommended action
  (`reuse`, `inspect`, `specify`, `buy`, or `none`);
- the evidence that caused the classification.

Required readiness totals exclude optional lines in every outcome state.
Optionality remains a separate flag and total, so a supplied optional line does
not inflate the required supplied count.

An insufficient requirement is `specify_first` / Decide, not missing stock. Its
`missingDecisions` identify the unanswered identity, purpose, electrical,
connector, compatibility, or dimensional choices. Power-supply requirements
must at least resolve current/load and connector before Source is permitted.
If a plausible recorded item still needs a count or compatibility decision,
Check takes precedence so the existing item can be inspected before shopping.
A known shortfall after confirmed partial coverage is Source for the remaining
quantity unless an inspect-first candidate could cover it.

Confirmed stock is consumed by allocation arithmetic, so two projects cannot
silently reserve the same available quantity. If no confirmed candidate covers a
fully specified required line, the agent may prepare a shopping proposal. It
must not reserve uncertain stock merely to make the gap disappear.

## Shopping-list semantics

Shopping output is a proposal composed from BOM gaps and offer observations:

Only required Source lines are eligible for shopping. Ready, Check,
`specify_first`/Decide, and optional lines are excluded. This avoids proposing
a purchase before required characteristics have been decided or while plausible
stock still needs inspection.

Show package rounding, observed price, currency, shipping when known, link, and
price age. Never claim that the offer is current without a fresh observation.
The `record_offer_snapshot` tool stores a supplied observation; it does not
retrieve the URL, add to a cart, or place an order.
