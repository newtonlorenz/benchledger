---
name: benchledger
description: "Use an existing BenchLedger workspace for maker inventory, BOMs, project artifacts and usage records. Applies to BenchLedger-backed maker work."
---

# BenchLedger

Answer the user's current maker-project question using evidence-backed records.
Continue the existing project and revision; do not restart intake or run the
whole lifecycle merely because this skill is selected.

## Connect and scope

Read benchledger://capabilities once when a session starts or when the tools
change; tools/list is the authoritative input contract. Use the callable tools
and their live schemas, scopes, annotations and approval boundaries. Refresh the relevant inventory/project state before a decision or
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
`commission_inventory_item` (or a confirmed inspection commit); metadata edits
and `count_correction` stock events cannot establish counted stock.
The human chooses when stock counts as in stock (workspace
`stockReceivingPolicy`: `on_receipt` default, `on_delivery`, `on_purchase`).
Read it from `refresh_context`; never try to change it. Policy-trusted rows
(`inStock: true`, `policyAvailability: "assumed"`) are usable but still
uncounted, so name that assumption when you rely on them.
A counted item can still require compatibility inspection.

For a visual project overview, use advertised `list_project_library` pages and
follow every returned cursor. To select a project image, read the current
revision's presentation and save an eligible attached PNG/JPEG/WebP of up to
20 MiB with its observed version. Label renders, references and build photos
honestly; never select historical or unrelated files or treat a picture as
physical validation. See [project images](../../docs/project-images.md).

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

An explicit request to upload, attach or sync identified build files to an
identified private BenchLedger project authorises that bounded transfer and its
necessary local reads; do not ask for a second approval for the same payload and
destination. Carry prior approval forward, including an accepted proposal that
specified the files. A request only to create a build plan does not by itself
approve copying private CAD or slicer files: finish independent planning and ask
one concrete question naming the files and private project/revision. Uploading
files does not authorise slicing, printing, publication or stock changes.
If platform approval review rejects a transfer, report its actual reason and
resolve the missing authorisation or target evidence. Do not retry through a
different mechanism to bypass the rejection; skill text cannot override it.

Use the smallest supported atomic operation matching the authorised request.
Pass current expected versions; on `version_conflict` re-read rather than force,
and on `rule_conflict` change the request. Writes accept an optional
`idempotencyKey` argument; when omitted, key-requiring commands derive one from
the arguments so an identical retry replays. Reuse a key only for an ambiguous
retry of the identical command/payload; distinct commands, including draft and
commit, need distinct keys. Ask the human before any `destructiveHint` tool.

Inspection completion and close-out require the server preview and explicit
confirmation before commit. A reservation is not consumption; planned amounts
are not actual usage. Preserve evidence and accepted artefacts. Generic MCP
transfer failures remain fail-closed: never embed general project files as
base64 or invent a host transfer. The explicit `add_inventory_image` tool is a
bounded PNG/JPEG/WebP exception: use exact approved host-encoded bytes and
honest source labels, as described in the inventory section of the lifecycle
reference. With host filesystem access permitted by the current task and platform, use
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

PCB inspection uses the existing `inspect_assembly_sources` workflow on exact uploaded files. Native KiCad `.kicad_pcb` sources require millimetres and Z up; source pads/outlines are not exact component bodies. Read all returned warnings. External models, paths and scripts are never resolved. The project PCB view is read-only; see [PCB viewer](../../docs/pcb-viewer.md).
