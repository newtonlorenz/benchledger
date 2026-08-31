# Synthetic reference project: desk sensor enclosure

This fixture is intentionally fictional and safe to publish. It exercises the
beginner and expert paths without exposing personal inventory, order numbers,
email IDs, credentials, or real supplier history.

## Project record

```yaml
project:
  id: project-desk-sensor
  name: Desk sensor enclosure
  status: active
  visibility: private
work_items:
  - id: work-enclosure
    name: Printed enclosure
    kind: part
  - id: work-electronics
    name: Sensor electronics
    kind: electronics
revisions:
  - id: project-rev-01
    number: 1
    status: concept
  - id: enclosure-rev-01
    number: 1
    status: CAD complete
```

## BOM and synthetic stock

| BOM line | Requirement | Quantity | Synthetic inventory result |
| --- | --- | ---: | --- |
| `bom-petg` | PETG HF filament | 180 gram | `filament-petg-hf` — confirmed, supplied |
| `bom-printer` | H2D printer, 0.4 mm nozzle | 1 piece | `printer-h2d` — commissioned, supplied |
| `bom-board` | ESP32 development board | 1 piece | `board-esp32` — confirmed, supplied |
| `bom-wire` | Dupont jumper wires | 1 set | `wire-dupont` — delivered_uncounted, inspect-first |
| `bom-insert` | M3 heat-set inserts | 4 piece | no candidate, missing |
| `bom-led` | Status LED | 1 piece | optional, no candidate |

The `calculate_bom_gaps` response should make the distinction visible:

```json
{
  "projectRevisionId": "project-rev-01",
  "lines": [
    {"bomLineId":"bom-petg","state":"supplied","recommendedAction":"reuse"},
    {"bomLineId":"bom-wire","state":"inspect_first","recommendedAction":"inspect"},
    {"bomLineId":"bom-insert","state":"missing","recommendedAction":"buy"},
    {"bomLineId":"bom-led","state":"optional","recommendedAction":"none"}
  ]
}
```

## Artifact set

The enclosure work item can contain these versioned revisions:

```text
enclosure_source.FCStd       role=source
enclosure_r01.step           role=step
enclosure_r01_print.3mf      role=three_mf
enclosure_r01.stl            role=stl
enclosure_r01_validation.md  role=validation
```

The agent begins each upload with the logical project/work-item/revision and a
safe filename, transfers bytes through the scoped HTTP URL, finalizes with a
SHA-256, and later reads download metadata. The typed MCP finalize command takes
only the upload ID because the application verifies the begin-time declaration
against stored bytes; agents using the returned HTTP finalize URL send the byte
length and SHA-256 payload. The MCP conversation never carries the CAD bytes as
base64.

## Beginner walkthrough

1. Ask “Can I build this with what I have?”
2. Refresh context and read the inventory summary.
3. Evaluate the BOM and explain `wire-dupont` as inspect-first.
4. Show one next action: count the wires or compare insert offers.
5. Produce a short list with one required purchase and no optional upsell.

## Expert walkthrough

1. Read exact item resources and stock-event history.
2. Compare the enclosure revision's machine, nozzle, material, dimensions,
   orientation, and evidence to the BOM constraints.
3. Upload source/STEP/3MF files and verify lengths and hashes.
4. Reserve only the confirmed printer/material/board lines.
5. Record actual wire count and insert purchase only after a human action.
6. Record validation observations and create a new work-item revision for any
   geometry or process change; never overwrite the accepted artifact.

## Expected agent answer

> “The synthetic build is mostly supplied. PETG, the H2D, and the ESP32 board
> are confirmed/commissioned and can be reused. Dupont wires are a plausible
> delivery but require a physical count before reservation. Four M3 inserts are
> missing. I can compare observed supplier offers and prepare a source-currency shopping
> proposal, but no purchase or printer action is available through MCP.”
