# BenchLedger mobile privacy policy

Effective date: 11 November 2026 (previous version: 14 September 2026)

BenchLedger for iPhone and Android connects to a BenchLedger server that you
choose. The app's developer does not operate a required cloud account service,
collect your inventory, sell personal data, or include advertising, tracking
or analytics SDKs in the mobile app.

## Your connection and workspace

The app sends your API token and the requests you make directly to your chosen
server. That server receives the inventory and project information needed to
answer your requests, and any item edits or projects you submit. Its operator
controls that server's storage, access, logs, retention and deletion. If someone
else operates your server, ask them for their privacy policy.

Your server address and API token are saved in protected device storage: iOS
Keychain or Android encrypted storage. So that the app works with poor or no
Wi-Fi, the most recent inventory and project responses, item photos you have
viewed, and stock counts or receipts you recorded but have not yet sent are
stored on the device in the app's private storage. They are kept separately
for each server and account (identified by a one-way digest, not your token or
account name) and are not shared with other apps. This local copy can be
included in your device's encrypted backups. Unsent stock changes are sent
only to your connected server. A `benchledger://pair` link can carry an API
token; the app only uses it to fill in the connect form for your review, never
connects automatically and never logs it. Treat such links like the token. Public server connections
require HTTPS. Local HTTP is available only after explicit opt-in and does not
encrypt information in transit.

The optional sample workspace contains synthetic data bundled with the app. It
does not contact a server, save credentials or transmit your activity.

## Deletion and control

Choose **Disconnect** in the Server tab to remove the saved connection, the
saved workspace responses, cached photos and any unsent stock changes from the
device; the app asks first if unsent changes would be lost. If the server stops
accepting your token, saved responses are removed and unsent stock changes are
kept until you reconnect with the same account or connect a different one. Disconnecting does not delete data from your
server or revoke the server token; contact its administrator for those actions.
iOS Keychain entries can survive uninstall, so disconnect before uninstalling
if you want to remove the saved token. Copies that you separately save in a
password manager are controlled through that password manager.

The app requests local-network access when connecting to a local server. It
asks for camera access only when you open the scanner or take an item photo;
the camera is used to read codes on the device and to capture the photo you
choose to upload. Choosing an existing photo uses the system photo picker,
which shares only the photo you select. Photos are resized and re-encoded
before upload, which removes location and other embedded metadata; they are
sent only to your server. The app does not request access to contacts,
location or the microphone. You can change these permissions in device
settings.

## Apple, Google and support

Apple and Google may process store, installation or diagnostic information
according to their own terms and your device settings. If you choose to share
TestFlight feedback or contact support, the information you send is used to
investigate and respond to that request. Do not include private inventory,
tokens or server credentials in public reports.

For privacy questions, or to request access to or deletion of support
correspondence, email [the app developer](mailto:daniel@newtonlorenz.com).
This is a private contact; do not include API tokens or server credentials.
For vulnerabilities, follow the [security reporting instructions](../SECURITY.md).
For general help, see [Support](../SUPPORT.md). Changes to this policy will be
dated on this page.
