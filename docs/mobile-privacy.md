# BenchLedger mobile privacy policy

Effective date: 14 September 2026

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
Keychain or Android encrypted storage. Workspace responses remain in app memory;
the app does not keep a persistent offline copy. Public server connections
require HTTPS. Local HTTP is available only after explicit opt-in and does not
encrypt information in transit.

The optional sample workspace contains synthetic data bundled with the app. It
does not contact a server, save credentials or transmit your activity.

## Deletion and control

Choose **Disconnect** in the Server tab to remove the saved connection and clear
workspace data from app memory. Disconnecting does not delete data from your
server or revoke the server token; contact its administrator for those actions.
iOS Keychain entries can survive uninstall, so disconnect before uninstalling
if you want to remove the saved token. Copies that you separately save in a
password manager are controlled through that password manager.

The app requests local-network access when connecting to a local server. You
can change that permission in device settings. It does not request access to
contacts, location, photos, microphone or camera.

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
