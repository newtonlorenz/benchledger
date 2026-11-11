# TestFlight and App Store preparation — 14 September 2026

## Verified release

BenchLedger `1.0.0 (2)` was archived, exported and uploaded using the
[release CLI](../mobile-release.md). App Store Connect reports `VALID` and
`APP_STORE_ELIGIBLE`. Internal testing is `IN_BETA_TESTING`; the external
group is attached to build 2 and its requested tester membership is verified.
External testing is `WAITING_FOR_BETA_REVIEW`. Invitation delivery and physical
installation have not been verified.

The first `0.1.0 (1)` upload succeeded through Xcode but was internal-only and
reported missing React, ReactNativeDependencies and Hermes symbols. The new
CLI downloads the matching official Release dSYMs, checks their publisher
checksums, UUIDs, architectures and real DWARF contents, and verifies coverage
for all nine app/framework executables before export and upload. The exported
IPA includes symbol files. Apple's build 2 upload reported no errors; no missing
symbol warnings appeared in its upload log.

Manual distribution signing uses an authorised Apple Distribution certificate
and App Store profile, with the private key in Keychain. API authentication
handles upload. This resolves the earlier CLI account/cloud-signing failures
without depending on Xcode Organizer's account session. Archives, credentials,
configuration, contact details, tester identities and logs remain outside the
public checkout.

## Verification

- Release archive, code-signature verification and CLI export passed.
- All nine executable UUID/architecture pairs have matching dSYMs.
- `NODE_OPTIONS=--no-experimental-webstorage npm run check` passed: 1,051 tests,
  the existing coverage thresholds, and all 130 Playwright checks. An earlier
  run had one web project-modal focus race; the full rerun passed without
  changing unrelated web behaviour. The Node option prevents experimental
  global storage from shadowing the browser test environment.
- The signed Release simulator app was inspected on iPhone 17 Pro Max with
  iOS 26.5. Sample inventory, item details, project requirements and leaving
  the sample worked. Its credentials are synthetic and remain offline.
- Four actual app screenshots at 1320 × 2868 were inspected, uploaded and
  confirmed `COMPLETE` by App Store Connect.
- The task-created capture simulator was stopped and shut down afterwards.

The available toolchain is Xcode 26.6 / iOS 26.5. Exact iOS 27 appearance and
physical-device testing remain outstanding. Android store distribution is not
part of this iOS release.

## Store preparation

Version `1.0.0` has build 2 selected. After explicit approval, the public
App Store submission was sent and verified as `WAITING_FOR_REVIEW`, with
manual public release. The English description, subtitle, promotional text,
keywords, support/marketing links, copyright, review contact and sample-mode
instructions are saved. The category is Productivity, the calculated rating
is 4+, and the draft price is Free across 175 territories.

The [mobile privacy policy](../mobile-privacy.md), including the expressly
approved private contact for personal-data requests, was published and merged
in [PR 69](https://github.com/newtonlorenz/benchledger/pull/69). Its corrected
commit passed both required GitHub checks, 1,004 local tests and 130 browser
checks. Only the policy was committed and merged. Store and TestFlight now use
the verified policy URL on `main`.

The App Privacy questionnaire was completed and published as **Data Not
Collected** through the supported Codex in-app browser control. Apple displayed
its publication confirmation. The earlier blocked browser-debugging probe was
not needed. Both the public App Store review and external TestFlight beta-review
requests are submitted; neither review is an approval or a public release.
