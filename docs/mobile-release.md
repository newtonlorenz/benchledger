# iOS release from the command line

Use Node 24, npm 11, Python 3.12+, CocoaPods and a supported Xcode. Release
archives, signing material and private configuration stay outside this checkout.
The release CLI never signs into, resets or changes Xcode's Apple accounts.

## Signing setup

The archive uses an existing App Store Connect API key for development
provisioning. Distribution export uses an installed **Apple Distribution**
identity and an **iOS App Store** provisioning profile for
`app.benchledger.mobile`. Upload uses the existing API key directly through
Apple's `altool`. This avoids relying on Xcode Organizer's cloud signing session.

An Account Holder or Admin must authorise creating a distribution certificate.
Keep its private key in Keychain and allow Apple's `codesign` to use that key.
Never check in `.p8`, `.p12`, `.mobileprovision`, Keychain files, passwords or
release logs. Do not revoke other certificates to make space without approval.

Create a private JSON configuration outside the repository and point
`BENCHLEDGER_RELEASE_CONFIG` to it. It contains these fields:

| Field | Value |
| --- | --- |
| `teamId` | Apple developer team identifier |
| `keyId` | Existing App Store Connect API key identifier |
| `issuerId` | API issuer UUID |
| `keyPath` | Absolute path to the private `.p8` file |
| `outputDirectory` | Absolute private directory for release output |
| `distributionCertificate` | SHA-1 fingerprint from `security find-identity -v -p codesigning` |
| `profileUuid` | UUID of the installed BenchLedger iOS App Store profile |

The last two fields are needed for export and upload. The CLI refuses paths
inside this checkout, including symlinks into it. Restrict the configuration's
permissions to its owner.

## Build, verify and upload

Set `expo.version` and increment `expo.ios.buildNumber` in `apps/mobile/app.json`.
Keep the `version` in `apps/mobile/package.json` (and its `package-lock.json`
workspace entry) equal to `expo.version`.
Build numbers must not be reused after an upload. From the repository root:

```bash
npm ci
npm run check
npm run release:ios --workspace=@benchledger/mobile -- archive "$BENCHLEDGER_RELEASE_CONFIG"
npm run release:ios --workspace=@benchledger/mobile -- export "$BENCHLEDGER_RELEASE_CONFIG"
npm run release:ios --workspace=@benchledger/mobile -- upload "$BENCHLEDGER_RELEASE_CONFIG"
```

If a Node 24 release exposes experimental global Web Storage to the browser
tests, run the check with `NODE_OPTIONS=--no-experimental-webstorage`. The DOM
test environment must provide its own `localStorage`; keep all checks enabled.

Archive generation runs Expo prebuild and CocoaPods before `xcodebuild archive`.
It embeds the production JavaScript bundle, installs official Release symbols,
checks every app/framework UUID and verifies the code signature. Existing
archives are preserved; an interrupted symbol step can be resumed with:

```bash
python3 apps/mobile/scripts/ios-symbols.py "$BENCHLEDGER_ARCHIVE" --cache "$BENCHLEDGER_SYMBOL_CACHE"
```

The symbol tool reads the installed React Native and Hermes versions, downloads
their official Maven Central archives and verifies publisher SHA-256 checksums.
Only matching UUID/architecture pairs with real DWARF debug information are
copied. It rejects unsafe archive entries and does not create empty dSYM shells
from stripped frameworks. Both export and upload re-check all archived symbols.

The CLI exports an App Store-eligible IPA, rather than an internal-only build.
`altool --wait` waits for Apple's upload processing. Afterwards, read the build
state in App Store Connect, attach it to the intended TestFlight group or App
Store version, and verify that state separately. Upload success is not review
approval or tester availability. An uncertain upload must be checked before
retrying; the CLI refuses an upload already recorded as successful.

Public App Store submission and release require their own approval. Keep the
version set to manual release while preparing it for review.
