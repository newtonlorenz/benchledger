# BenchLedger for iPhone and Android

The native client lives in `apps/mobile`. It uses Expo SDK 57, React Native,
TypeScript and the shared API contracts. Both phone platforms use the same
screens and application client. The web app remains the full desktop workspace.
This is an initial mobile companion, not full web feature parity or an app-store
release. No BenchLedger cloud account or Expo account is required for local use.

**Explore a sample workspace** opens bundled synthetic records without a server,
credentials or network traffic. It is read only and visibly labelled; leave it
from the Server tab before connecting to your own workspace.

## Supported workflows

The iPhone interface targets iOS 27 with native Liquid Glass tabs, large
titles, native search and toolbar actions, inset lists and grouped details.
See the [mobile design system](../apps/mobile/DESIGN.md) and
[design verification record](reviews/2026-09-14-ios27-design.md).

- Connect directly to a user-selected BenchLedger server, including a reverse
  proxy subpath or an address ending in `/api/v1`.
- Store the server address and token in iOS Keychain or Android encrypted
  storage; restore the connection when the app starts and disconnect locally.
  A saved connection opens the workspace immediately and is verified in the
  background. Writes stay disabled until the server confirms the token's scopes.
- Search inventory and projects with automatic paging at the end of the list,
  pull to refresh, inspect evidence, recorded and available quantities,
  locations, project revisions and requirements. Rows show the decision-relevant
  figure, for example `1,000 g` or `Available 3 of 5 pieces`.
- Returning to a screen shows what was already loaded and refreshes it in the
  background ("Updating…"), keeping loaded pages and scroll position. Visible
  screens also refresh when the app returns to the foreground (at most every
  30 seconds). This cache lives in memory for the current session only.
- Edit item name, description and location. The form loads the current item
  and sends its version with a stable retry key. If someone else changed the
  item meanwhile (HTTP 409), the app shows the latest server values and offers
  **Keep my changes and retry** or **Discard my changes**. Retrying sends only
  the fields you changed, applied onto the latest record, so fields changed by
  someone else are kept. If both sides changed the same field, the app shows
  both values and you choose which to keep before retrying. These edits do not
  count, consume or commission stock.
- Create a project and its first concept revision atomically, with a stable
  retry key. New projects begin as ideas with an undecided fabrication route.
- Respect read-only and project-scoped tokens. Shared inventory remains
  readable as permitted by the existing API; workspace writes need an unscoped
  write/admin token. Project lists preserve the server's scope filtering.

Use the web workspace for stock counts, procurement, reconciliation, file
uploads, CAD viewing and detailed build planning. The mobile requirements list
does not claim stock readiness. There is no persistent offline cache, offline
write queue, camera scanner, automatic server discovery or printer-control
feature.

### Offline launch and server health

If the saved server cannot be reached at launch, the app still opens the
workspace and shows **Can't reach your workspace** with **Retry**. Nothing is
cached on disk between launches yet, so a cold offline launch has no records
to show. Only a definitive HTTP 401 clears the saved session; timeouts, network
errors and 5xx responses never do. A server reporting `degraded` health is
connected with a visible warning rather than refused.

A server that refuses the address itself is a configuration problem, not an
outage, and is not retried automatically. HTTP 421 (`host_not_allowed`) shows
"This server doesn't accept this address": add the host to
`BENCHLEDGER_ALLOWED_HOSTS` on the server or connect using its public address.
A cross-origin 403 is reported the same way. HTTP 428 asks you to refresh the
record and retry with its current version.

Reads ignore response fields this app does not know, so a newer server can add
fields without breaking the app; quantity invariants and required fields are
still enforced. Before sending the token, the app reads the public
`/api/v1/capabilities` route and refuses a server whose `protocol` is not one
it supports (currently `rest-v1`). Servers without that route are accepted.
`/api/v1/health` exposes only the server's release `version`, which is shown
in the Server tab; it is not used for compatibility decisions.

### Links

The app registers the `benchledger://` scheme:

| Link | Opens |
| --- | --- |
| `benchledger://item/<id>` | An inventory item, above the inventory list |
| `benchledger://project/<id>` | A project, above the project list |
| `benchledger://inventory`, `benchledger://projects`, `benchledger://server` | That tab |
| `benchledger://pair?url=<server>&token=<token>` | Fills in the connect form |

Record links work while a workspace is open (including on a cold start with a
saved connection). Malformed record IDs are rejected before any request. A
pairing link only prefills the server address and token; it never turns on
**Allow local HTTP**, which the user must switch on for an `http://` address.
The user must review and tap **Connect**. Android can report the same launch
link on later cold starts, so the app keeps a SHA-256 hash (never the link or
token) of the last consumed pairing link in secure storage and ignores a
repeat.
It is ignored, with an explanation, while a workspace is already open. The app
never logs a pairing link, but anything that handled it (a QR scanner, chat or
clipboard history) may keep the token, so prefer showing a QR code in person.

## Connect a server

1. Enter the full workspace address, for example
   `https://benchledger.example.com`.
2. Paste a scoped HTTP/API bearer token supplied by the server administrator.
   The workspace's browser password is not an API token. Existing server token
   configuration also works for the mobile HTTP client; see the commented
   `BENCHLEDGER_MCP_READ_TOKEN_HASHES` and `BENCHLEDGER_MCP_WRITE_TOKEN_HASHES`
   fields in [the environment example](../.env.example). The server receives
   the SHA-256 digest in its private configuration; the app receives the
   plaintext token. Do not store either in public source or app configuration.
3. Tap **Connect to server**. The client checks public server identity before sending
   the token, then verifies the authenticated session and scopes.

HTTPS is required for public hosts. **Allow local HTTP** is an explicit opt-in
for local destinations only: RFC1918 IPv4, loopback, IPv4 link-local,
carrier-grade NAT `100.64.0.0/10` (Tailscale addresses), `.local`, `.lan` and
`.home.arpa` names, and IPv6 loopback, link-local (`fe80::/10`) and
unique-local (`fc00::/7`) addresses. Single-label names such as `http://nas`
are not treated as local, because a DNS search domain can resolve them to a
public host; use `nas.lan`, `nas.local`, `nas.home.arpa` or the IP address.
HTTP does not encrypt credentials or workspace data. iOS requests local-network
permission and allows local networking through ATS, with ATS exceptions for
`.lan` and `.home.arpa`. Android permits cleartext at the OS level because its
network security configuration can match hostnames but not IP ranges, and
server hosts are selected at runtime; the app's URL policy restricts HTTP to
consented local destinations. Public hosts still require HTTPS. Use a trusted
certificate; the app never bypasses certificate checks. The wider local-name
and IPv6 coverage is unit-tested; it has not yet been verified on devices.

The phone must be able to reach the server, for example on the same Wi-Fi or
through an already configured VPN. `localhost` on a physical phone is that
phone, not the server. An iOS local-network denial can be changed in Settings.
Use the final server address: HTTP redirects are rejected before following
them, including authenticated requests. Credentials are never put in URLs.

An expired token (HTTP 401) clears the active workspace. Network errors leave
an explicit warning beside any previously loaded information. An unexpected
rendering fault shows **Something went wrong** with **Try again** instead of a
blank app. A disconnect aborts pending
requests, removes the saved connection, and drops all in-memory workspace data.
Keychain entries can survive iOS uninstall; use **Disconnect** before removing
the app if you want to remove the stored token.
Some iOS versions may also offer the system **Save Password?** prompt after
connection despite the field disabling autofill. Choose **Not Now** to keep
the token only in the app's secure storage. Disconnect cannot remove a copy
separately saved in a password manager.

## Develop and validate

Use Node.js 24 and npm 11 from the repository root:

```bash
npm ci
npm run build
npm run mobile
```

The normal build exports both phone bundles. It does not compile or sign native
applications. Native generation and local compilation are separate:

```bash
npm run native:generate --workspace=@benchledger/mobile
npm run ios --workspace=@benchledger/mobile
npm run android --workspace=@benchledger/mobile
```

Local iOS builds need a compatible Xcode and CocoaPods. Android needs the
Android SDK and JDK. SDK 57 targets iOS 16.4+ and Android 7+; use the current
[Expo compatibility table](https://docs.expo.dev/versions/latest/) when updating.
Use a native development/release build for the iPhone navigation; Expo Go is
not the validation target for the native-tabs API. iOS 27 is the design target;
the deployment minimum still allows earlier supported systems to render their
own native navigation. Exact iOS 27 appearance needs Xcode 27/iOS 27 validation.
Generated `ios`, `android` and `.expo` directories stay out of Git and Docker.
Public-source scanners omit them only when none of those paths is tracked.
The server Docker image excludes the mobile workspace and installs only its
server/web/package workspaces; `build:server` keeps native bundling out of that
image build.

After a server build, a disposable loopback-only demo can exercise the iPhone
simulator without touching a real workspace:

```bash
npm run mobile:demo
```

Use `http://127.0.0.1:8796`, enable local HTTP, and enter the printed synthetic
token. The data lives only in memory and disappears when that process stops.
An Android emulator normally reaches host loopback through `10.0.2.2`.

```bash
npx vitest run apps/mobile/src
npm run typecheck --workspace=@benchledger/mobile
npm run mobile:export
npm run public:check
npm run check
```

The mobile tests run in Vitest without a simulator. They cover the API client
against the real Fastify application with synthetic records, forward-compatible
reads, the local-address policy, quantity presentation, the connect/restore/
offline/401 session controller, pairing and record links, stale-while-revalidate
loading and paging, the edit-conflict flow, foreground throttling and the error
boundary. Screen components themselves (`screens.tsx`, `App.tsx`) are not
rendered in tests; their logic is extracted into the tested modules. Native
builds and screenshots are distinct from these tests and from physical-device
or store verification.

Changes to `app.json` (background colour, Android adaptive icon, ATS exception
domains) and to the config plugin take effect only after native regeneration
(`native:generate`) and a rebuild.
See the [initial implementation and verification record](reviews/2026-09-14-native-mobile.md)
for the tested platforms, screenshots and remaining release checks.

## Known gaps and follow-ups

- Persistent offline cache and offline write queue. Needs a storage dependency
  such as `expo-sqlite` or MMKV; the current cache is in memory only.
- Launch splash screen with light/dark backgrounds. Needs `expo-splash-screen`,
  which is not installed; the root background colour and runtime system UI
  colour are set meanwhile.
- A dedicated Android adaptive-icon foreground asset. The existing icon is used;
  its bars sit inside the adaptive safe zone, but check it on device.
- The extra top spacing above iOS large titles on Inventory needs simulator
  investigation; it was not reproduced or changed here.
- Camera capture into the inventory image gallery.
- Barcode/QR scanning and printable location labels.
- A quick count/adjust stock flow with haptics.
- Android build in CI.
- Refreshed store screenshots: the current ones predate the **Explore a sample
  workspace** button.

## Architecture and dependency decisions

Expo provides native controls and one mobile codebase. Capacitor would reuse
the DOM UI but render screens in a WebView; Swift and Kotlin would create two
separate clients. Server business rules remain in the shared application layer.
There is no new server route, migration or authentication mode.

React 19.2.8 is shared with the web app, within React Native 0.86.3's declared
peer range. Expo's checker expects exactly 19.2.3 and reports that patch
difference. Keep the discrepancy visible; do not suppress the check or
downgrade the existing web dependency just to silence it.

Two targeted dependency overrides avoid known vulnerable transitive versions:
`xcode` uses UUID 11.1.1 (its required `v4()` API is unchanged), and React
Navigation uses query-string 9.5.1. A small Metro adapter exposes that parser's
named API for React Navigation 7. Parser compatibility has a focused test.
Recheck these overrides when upgrading Expo or React Navigation. The
root also declares their parent packages as build/test dependencies so npm 11
applies the overrides consistently across workspaces. The
[third-party notices](third-party-notices.md) record the BSD licence choice for
node-forge in Expo's build tooling.

## Release and rollback

The first internal TestFlight build was `0.1.0 (1)`. The App Store preparation
targets version `1.0.0`, build `2`; the workspace `package.json` version
matches `expo.version`; increment
`expo.ios.buildNumber` before uploading a subsequent build. The bundle identifier
is `app.benchledger.mobile`. Native generation carries the version and build
number into the generated Xcode project.

TestFlight distribution requires an Apple developer team, an App Store Connect
app entry, a distribution-signed export and a processed build assigned to a
tester group. Supply team and signing configuration outside public source.
An archive or successful JavaScript export alone is not a TestFlight release.
See the [first TestFlight release attempt](reviews/2026-09-14-testflight.md)
for verified progress and remaining account-access blockers. Physical-device
and exact iOS 27 validation remain outstanding.

No EAS project, cloud build or over-the-air update channel is created by these
scripts. TestFlight approval does not authorise a public App Store release or a
server deployment.

The mobile client can be removed from a device without migrating or rolling
back the server. Local disconnect does not revoke a server token; an
administrator manages token revocation on the server separately.

See [CLI releases](mobile-release.md) and the [mobile privacy policy](mobile-privacy.md).
