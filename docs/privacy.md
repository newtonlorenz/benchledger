# Privacy model

BenchLedger separates open-source application code from private instance data.

## Public layer

The public repository may contain code, migrations, documentation, prompts,
synthetic fixtures, example deployment files, and generated API schemas.

## Private layer

Keep inventory, project files, order and email provenance, supplier history,
databases, logs, backups, credentials, and tokens in the configured data directory
outside the checkout. A project is private by default; open-source software does
not make instance content public.

Any future public project export must be explicit, sanitized, independently
reviewed, and assigned its own content license. It must never be inferred from an
application visibility flag.

## Import rule

Importers preserve provenance and uncertainty. An order or delivery record is
evidence that an item may have arrived, not proof that it remains available.
