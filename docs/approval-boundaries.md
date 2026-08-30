# Agent approval boundaries

BenchLedger is designed to help an agent plan and explain an end-to-end maker
project while keeping consequential actions explicit. The MCP adapter is a
capability boundary, not an autonomous purchasing or printer-control agent.

## Allowed without a second approval

Subject to the token's scopes and project allow-list, an agent may:

- read bounded inventory, project, BOM, artifact metadata, offer, and context
  resources;
- create or update project metadata, work items, revisions, BOM requirements,
  inventory descriptions, and supplier observations;
- record append-only stock events, reservations, releases, and actual usage;
- begin and finalize an upload after bytes are transferred through a scoped HTTP
  URL;
- retire logical metadata or artifact records while retained history remains.

The application still validates inputs, versions, project scope, paths, hashes,
quotas, and authorization. The agent must report the IDs and resulting state.

## Always human-approved outside this adapter

The following are intentionally not MCP tools:

- placing or submitting an order, adding to a cart, paying, or purchasing;
- fetching arbitrary supplier URLs or scraping live prices;
- publishing a project, pushing a public repository, or deploying a service;
- changing credentials, token scopes, or authentication configuration;
- permanently purging records, blobs, backups, or audit history;
- starting a printer, heating a machine, moving hardware, generating/submitting a
  print job, flashing firmware, or changing printer configuration;
- claiming a safety-relevant fit, strength, thermal, electrical, child-contact,
  food, medical, pressure, or fire result without a competent human review;
- executing an uploaded file, shell command, SQL statement, or arbitrary path.

## How to word an agent handoff

Lead with the decision and residual uncertainty. A useful handoff says:

> “The enclosure is buildable with confirmed H2D and PETG stock. The ESP32
> board is confirmed; the Dupont wires are delivery evidence only, so inspect
> them before reserving. One M3 insert line is missing. I prepared two observed
> supplier offers totaling approximately EUR 8.40; no link was fetched and no
> purchase was made.”

Do not collapse “researched,” “proposed,” “reserved,” “purchased,” “delivered,”
and “physically verified” into one status.
