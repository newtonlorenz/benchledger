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

## BOM evaluation

For each line, the service considers the exact item, explicit alternatives, unit,
declared constraints, dimensions, machine/process requirements, condition, and
stock state. The response must include:

- requested and supplied quantities in canonical units;
- candidate item IDs and compatibility reasons;
- whether the candidate is confirmed or inspect-first;
- shortfall and recommended action (`reuse`, `inspect`, `buy`, or `none`);
- the evidence that caused the classification.

Confirmed stock is consumed by allocation arithmetic, so two projects cannot
silently reserve the same available quantity. If no confirmed candidate covers a
line, the agent may prepare a shopping proposal. It must not reserve uncertain
stock merely to make the gap disappear.

## Shopping-list semantics

Shopping output is a proposal composed from BOM gaps and offer observations:

```text
already supplied | inspect-first | required purchase | optional purchase | substitute
```

Show package rounding, observed price, currency, shipping when known, link, and
price age. Never claim that the offer is current without a fresh observation.
The `record_offer_snapshot` tool stores a supplied observation; it does not
retrieve the URL, add to a cart, or place an order.
