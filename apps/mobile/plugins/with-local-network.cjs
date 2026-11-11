const { withAndroidManifest } = require("expo/config-plugins");

// Self-hosted servers have user-selected hosts, which cannot be enumerated in
// a static Android network policy. Android's network security config matches
// exact hostnames and domain suffixes only; it cannot express IP ranges such as
// 192.168.0.0/16 or 100.64.0.0/10, which are the common way to reach a home
// server. A domain-only policy would therefore break IP-address connections,
// so cleartext stays enabled at the OS level and the client enforces the
// boundary instead: `normaliseServer` permits HTTP only for local hosts
// (see src/connection.ts isLocalHost) after explicit user consent, and every
// public host requires HTTPS. Revisit if Android adds range-based policies.
module.exports = function withLocalNetwork(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults.manifest.application[0].$["android:usesCleartextTraffic"] = "true";
    return config;
  });
};
