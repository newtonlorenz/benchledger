---
name: benchledger
description: Use an existing BenchLedger MCP/API workspace to inspect maker inventory, plan a 3D-printing or electronics project, evaluate BOM gaps, propose sourcing, bind revisioned files or reconcile actual usage. Not a general coding, shopping or printer-control skill.
---

# BenchLedger

Answer the user's current maker-project question using evidence-backed records.
Continue the existing project and revision; do not restart intake or run the
whole lifecycle merely because this skill is selected.

## Connect and scope

Read benchledger://capabilities when establishing a session or when capabilities
change. Use the callable tools and their live schemas, scopes and approval
boundaries. Refresh the relevant inventory/project state before a decision or
write; avoid repeated identical discovery when the contract is unchanged.
A documented tool that is absent is not callable: refresh/reconnect once where
supported, then report the missing capability and continue safe independent
work. Never substitute shell, SQL, absolute paths or guessed handles.

Use bounded reads and returned cursors. Read only the relevant stage in
[references/lifecycle.md](references/lifecycle.md). Read
[references/client-setup.md](references/client-setup.md) only for integration
setup. With repository access, apps/mcp/QUICKSTART.md is the technical manual;
docs/capability-map.md and docs/stock-evidence-semantics.md explain contracts.

## Evidence and decisions

Keep catalog product, owned physical item, profile/link and immutable build
configuration separate. Orders/deliveries, names, photos and reported/suggested
links do not establish current usable quantity, exact identity or compatibility.
Use confirmed quantity, unit, condition, constraints, provenance and current
project state. Commission physically checked orders/deliveries through
`commission_inventory_item`; metadata edits cannot establish counted stock.
A counted item can still require compatibility inspection.

Explain required BOM lines as Ready, Check, Decide or Source. Resolve exact
missing decisions before sourcing; keep plausible unconfirmed candidates Check,
not reserved or consumed. Only required Source lines enter a shopping proposal.
Only `consumed` BOM requirements may reserve stock, record usage or enter
close-out; `reusable` and unspecified roles do not authorize those operations.
Keep printers in build configurations, outside BOM stock. Keep optional lines
separate. Include offer source/time, currency, package rounding and remaining
quantity; price observations can be stale. A proposal
is not an instruction to buy. Ask only for missing facts that materially affect
safety, specification, compatibility or availability.

## Writes and release boundaries

Use the smallest supported atomic operation matching the authorised request.
Pass current expected versions; on conflict re-read rather than force. Reuse an
idempotency key only for an ambiguous retry of the identical command/payload;
distinct commands, including draft and commit, need distinct keys.

Inspection completion and close-out require the server preview and explicit
confirmation before commit. A reservation is not consumption; planned amounts
are not actual usage. Preserve evidence and accepted artefacts. Generic MCP
transfer failures remain fail-closed: never insert file bytes as base64 or
invent a host transfer. With separately authorised host filesystem access, use
the repository helper described in
[client setup](references/client-setup.md#host-file-transfer).
Report a committed write as committed even if a later
refresh fails; do not duplicate it.

Purchasing/carts, external publication, deployment, credential changes,
destructive removal/history deletion, printer control/heating, print submission,
firmware flashing and physical tests need explicit approval for that action.
Do not weaken these boundaries to satisfy a broader automation request.

## Status and response

Project lifecycle is idea, planned, ready, building, validating, complete or
archived. Blocked is a derived condition, not a lifecycle value. The revision's
manufacturing-evidence ladder is separate: moving lifecycle never proves CAD,
slicer, physical, electrical or fit/function validation. Follow the active
fabrication project's engineering rules too.

Lead with the answer and next material action, not a fixed report template.
Show Ready/Check/Decide/Source and optional context when explaining a BOM.
Expose exact IDs, versions, quantities/units, source age, compatibility evidence,
hashes and audit results when requested or decision-relevant. State the actual
changed records, verified result and unresolved constraint; do not claim an
entire project completed from a single successful tool call.
