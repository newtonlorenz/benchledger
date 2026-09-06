# Maker customer-experience review

Date: 6 September 2026. Baseline: `05e4677` (PR #40).
Scope: self-hosted maker projects, owned inventory, evidence-aware planning,
files and authorised agent access. This is a code/workflow review with synthetic
acceptance tests, not a customer study, certification or deployment claim.

## Product decision

Optimise for a serious hobbyist or solo/small-workshop professional who needs
to turn a design into an executable, traceable project: what is required, what
is already owned, what needs checking, what needs buying, which files belong
to the revision, and what actually happened after the build.

The strongest differentiator is one trustworthy project model shared by people
and agents. Do not create a parallel agent-only workflow or a generic ERP.
Printers are workshop capabilities, not consumable BOM entries. Electronics-only
and ready-made projects remain first-class. Discovery, evidence, allocation and
physical completion are separate concepts.

## Competitive reference points

Primary product references were inspected for capabilities, not marketing claims
about adoption or quality:

- [PartsBox features](https://partsbox.com/features.html) and
  [build workflows](https://partsbox.com/builds.html): a benchmark for useful
  BOM, inventory and build workflows rather than isolated record-entry screens.
- [InvenTree documentation](https://docs.inventree.org/en/1.3.x/manufacturing/build/):
  a benchmark for production-oriented structure and inventory allocation.
- [Spoolman](https://github.com/Donkie/Spoolman): a benchmark for specialised
  consumable tracking and printer integrations.

BenchLedger should not claim parity with all three. Its near-term opportunity
is a simpler mixed printing/electronics project workspace with inspect-first
truthfulness, explicit revision context and useful authorised-agent parity.
Specialist integrations should be assessed before duplicating those systems.

## Findings and implemented decisions

| Finding | Change | UX / DX / AX consequence |
| --- | --- | --- |
| Requirements could be added but not generally corrected in the browser | Add edit, confirmed retirement and revision-scoped restoration | Makers can fix mistakes; developers reuse application commands; agents and HTTP follow the same durable identity and version rules |
| Project management was more capable through the API than the UI | Edit name, brief and stage while retaining the project graph | Stage is progress, not invented manufacturing evidence or stock consumption |
| A committed create could look failed when readiness refresh failed | Cache the acknowledged line first; explicitly mark readiness unavailable | Avoid duplicate retries and prevent stale readiness from being presented as current |
| Lost or malformed acknowledgements could encourage replacement writes | Retain the same command identity for unchanged retries; validate acknowledgements | Preserve drafts and distinguish committed, unconfirmed and refreshed state |
| Clearing an incorrect selected item was not a supported update | Support explicit null only in the update contract | Omission preserves the link; clearing does not delete alternatives, specifications or ownership |
| HTTP rejected legitimate project-scoped requirement corrections | Resolve durable line-to-revision-to-project ancestry | Least-privilege agents can complete the workflow without obtaining a global token |
| Allocated requirements could change quantity/item assumptions | Share an allocation-sensitive edit guard across service and both adapters | Prevent invalid reservations while allowing descriptive corrections and the existing legacy-role repair |
| Larger plans became long undifferentiated lists | Add search and decision-state filtering for larger BOMs | Locate the next relevant part without changing global readiness, export scope or inventory |
| Search required one contiguous phrase | Share accent-, punctuation- and word-order-aware discovery | Natural queries work consistently; discovery does not become a compatibility assertion |
| Project handoff depended on copying screen contents | Add requirements CSV and a versioned JSON project brief | Reviewable handoff with IDs, versions and file metadata; no credentials, file bytes or command authority |
| Mobile setup repeated the same decision twice | Remove the duplicate undecided build-approach card | Less scrolling and one clear setup action without removing configured printer context |
| Practice-mode project identity/version handling was incomplete | Give synthetic projects explicit versions and collision-resistant local IDs | New correction workflows work in the sample as well as the connected app |
| Roadmap statuses incorrectly described delivered capabilities as proposed | Reconcile the delivery index and affected quickstarts | Avoid duplicate implementation and misleading capability expectations |

## Acceptance coverage

The inherited release suite covers project creation, routes/printers, inventory
and bulk changes, inspection, revisions, files, shopping, reconciliation,
archive/restore, authentication, navigation and responsive behaviour. This pass
adds correction-specific tests rather than treating a green existing suite as
proof of new behaviour.

New acceptance work covers:

- Desktop and narrow-phone create/edit/remove/restore/export journeys.
- Lost create responses, malformed acknowledgements, failed readiness refreshes
  and optimistic-concurrency conflicts with the draft retained.
- Project-scoped HTTP and MCP selected-item clearing, wrong-project/read-only
  denial, indirect-ID non-disclosure and unchanged inventory quantities.
- Real SQLite and memory implementations, including direct-adapter attempts to
  change reserved planning assumptions without the service layer.
- Search normalisation, safe CSV quoting/formula handling, explicit JSON
  projections and absence of unrelated fields from handoffs.
- Fresh durable empty-workspace onboarding; the browser-created requirement is
  read through HTTP and MCP and compared with the corrected quantity.
- Independently rendered desktop, 390 px and 320 px screens, actual mobile save
  hit testing, Escape behaviour and browser error monitoring.

Required verification is `npm run check`, `npm audit --omit=dev` and separate
final diff/privacy review. Test execution is not deployment or physical-build
validation. The final exact execution results are recorded with this branch.

## What is not yet feature-complete

The core single-workspace correction and handoff workflow is materially stronger,
but a broad professional production-platform claim is not supported. Important
remaining gaps are explicit, not hidden behind a universal completeness label:

1. Guided project templates and multi-item setup need a useful browser
   Describe/Review/Create flow over the existing atomic setup contract.
   BOM import must preview mapping, units, identity and conflicts before commit;
   the exported CSV is not currently an import contract.
2. Sourcing for an unmatched requirement needs a proper offer/candidate model
   and a browser recording path. Do not fabricate owned stock merely to attach
   a supplier offer. Cost, package quantity, currency and observation time must
   remain explicit.
3. Larger projects need validated multi-plate/repeated-part planning and better
   work-item/revision navigation. Professional teams additionally need an
   explicit multi-user permissions, concurrency and audit model, not several
   people sharing an administrator session.

Ranked structured search, atomic batch file transfer and no-key online catalogue
lookup remain separate scoped work. Do not replace safe manual fallbacks with
unrestricted scraping or silently weaker permission boundaries.

## Next validation decision

Before broadening into production management, observe a real beginner and an
experienced maker completing the same bounded project from an empty workspace.
Measure unaided completion, time to identify reusable stock, corrective retries,
readiness misunderstandings and handoff success. A usability claim based solely
on automated tests remains provisional. The evidence should determine whether
guided setup, sourcing or larger-project navigation deserves the next investment.

## Release boundary

This review does not authorise a new deployment, external publication, purchasing,
credential changes, real inventory mutation or printer operation. Existing live
services and unrelated working trees are outside the implementation scope.

## Verified execution result

The final local release gate completed successfully on Node.js 24 and npm 11:

- 900 unit/integration tests passed across 88 test files.
- 72 Playwright browser flows passed, including the inherited 65 workflows.
- Package/application builds, workspace typechecks and coverage thresholds passed.
- Privacy/public-source and staged whitespace checks passed.
- The production dependency audit reported zero known vulnerabilities.
- A fresh temporary SQLite workspace passed browser onboarding and correction,
  with matching requirement read-back through HTTP and authenticated MCP.
- Rendered 1440 px, 390 px and 320 px layouts passed overflow checks; the mobile
  save control passed actual pointer hit testing and Escape restored the page.

These results apply to this local branch, not the live deployment. No external
publication, merge, deployment or real inventory mutation was performed. The
review's synthetic browser sessions and test servers were closed. The build
still reports its existing large JavaScript chunk warning; this pass makes no
claim to have benchmarked or resolved application performance at production scale.
