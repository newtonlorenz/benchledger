# BenchLedger mobile design

The iPhone design targets iOS 27. Android shares the content, typography scale
and domain behaviour, with its existing platform navigation and search fields.
This is a task interface for finding parts and continuing maker projects.

## Native system layer

Use UIKit-backed tabs, navigation bars, stacked search and toolbar actions on
iPhone. The OS owns Liquid Glass rendering, system symbols, transitions and
accessibility adaptations. Do not recreate the material with custom blur,
gradients or opacity overlays. Content surfaces remain opaque and readable.
The installed React Navigation native-tabs entry point is still marked
`unstable`; preserve the lockfile and review that API on dependency upgrades.

Large titles establish the top-level sections. Search stays visible below
the title. The project creation action and the inventory **Scan** action live
in the native trailing toolbar. The space above a large title is UIKit's
navigation bar row; on the iOS 27 simulator it matches the system Settings app,
so the app adds no inset of its own there.
Detail screens use compact native headers and an item or project identity
above grouped information. All three tabs remain available and labelled.

## Content system

Use the platform system font with normal Dynamic Type scaling. Reference
sizes: body 17/24, metadata 14/20, section title 21, content title 30/36 and
connection title 36/41. Native navigation owns its own typography.

Use 20-point content insets, 22-point grouped corners, 16-point input corners
and 54-point minimum primary buttons. Related records share one inset surface;
use separators within it, with no hairline after the final row. Icons help distinguish parts, tools and projects.
Decorative glyphs are hidden from accessibility. Row labels retain quantities,
locations and evidence uncertainty. Unit corrections override confirmed badges.

| Token | Light | Dark |
| --- | --- | --- |
| Background | `#f5f4f1` | `#111210` |
| Content surface | `#ffffff` | `#20221f` |
| Primary text | `#22221f` | `#f4f4ed` |
| Secondary text | `#686862` | `#adada5` |
| Accent | `#b84213` | `#ffa16e` |
| Accent surface | `#fae9df` | `#3c2a20` |
| Status text | `#3c5470` | `#b9cbe2` |
| Status surface | `#e7edf4` | `#26303c` |

Use warm orange for primary actions and selected controls. Project lifecycle
badges use the separate slate status tokens so a status never reads as a
button. Evidence keeps
its separate green/amber semantics; colour is always accompanied by text.
Errors use an explicit message and a recovery action. Background
revalidation keeps content in place and shows a quiet "Updating…" line; it
never blanks a loaded screen. Form labels are visual only; the input carries
the spoken label. No visual element may
turn recorded stock into proof of readiness or an idea into a completed build.

The launch screen uses the background token (`#f5f4f1` light, `#111210`
dark) with the app icon, and stays until the first screen is chosen. Stock
steppers are at least 64 points, in a decrease row and an increase row, with a
selection haptic per step and a success haptic when a change is saved. A stock
change is always confirmed with explicit before → after figures. Queued
changes use status colours with text: waiting (status), needs a decision or
not accepted (error) and sent (success). The camera scanner is a full-screen
modal; its instruction panel is the only translucent surface, over the live
camera image.

When the preferred text size changes, remeasure scroll content while keeping
form values, searches and fetched data in the owning screen. Fact rows and
stock quantities stack at larger text sizes. Do not shrink text to force it
into fixed row heights. System navigation handles its own motion preferences;
the content layer adds no entrance animations.

## Design evidence and validation boundary

- [Apple's iOS 27 page](https://www.apple.com/os/ios/) confirms availability
  from 14 September 2026.
- [WWDC26 design guidance](https://developer.apple.com/wwdc26/guides/design/)
  prioritises consistency, readability and accessibility.
- [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)
  places glass in the navigation/control layer.
- [Native tab documentation](https://reactnavigation.org/docs/native-bottom-tab-navigator/)
  documents UIKit integration and the evolving navigator API.

iOS 27 is the design target, not a claim about the OS used for screenshots.
The available local build tools are Xcode 26.6 with an iOS 26.5 simulator.
Build with Xcode 27 and verify on iOS 27 before asserting release compatibility
or exact appearance under that OS's glass and accessibility settings.
