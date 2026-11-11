#!/usr/bin/env node
// All release state and signing configuration belong outside this public repo.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const mobile = resolve(root, 'apps/mobile');
export function outsideCheckout(path, checkout = root) {
  if (!isAbsolute(path)) throw new Error('Use absolute paths for private release files');
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
  const rel = relative(realpathSync(checkout), canonical);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('Release files and credentials must stay outside the checkout');
  }
  return canonical;
}

export function validateConfig(config, requireDistribution = true) {
  for (const key of ['teamId', 'keyId']) {
    if (!/^[A-Z0-9]{10}$/.test(config[key] ?? '')) throw new Error(`Invalid ${key}`);
  }
  if (!/^[0-9a-f-]{36}$/i.test(config.issuerId ?? '')) throw new Error('Invalid issuerId');
  for (const key of ['keyPath', 'outputDirectory']) outsideCheckout(config[key] ?? '');
  if (requireDistribution && !/^[A-F0-9]{40}$/i.test(config.distributionCertificate ?? '')) {
    throw new Error('Set distributionCertificate to an installed Apple Distribution certificate SHA-1');
  }
  if (requireDistribution && !/^[0-9a-f-]{36}$/i.test(config.profileUuid ?? '')) throw new Error('Invalid App Store profile UUID');
  return config;
}

function run(command, args, options = {}) {
  execFileSync(command, args, { cwd: root, stdio: 'inherit', ...options });
}
function plist(data, path) {
  // JSON is piped, never interpolated into shell code.
  execFileSync('plutil', ['-convert', 'xml1', '-o', path, '-'], { input: JSON.stringify(data) });
}

export function main(argv = process.argv.slice(2)) {
  const [action, configPath] = argv;
  if (!['archive', 'export', 'upload'].includes(action) || !configPath || argv.length !== 2) {
    throw new Error('Usage: ios-release.mjs <archive|export|upload> /absolute/private/release.json');
  }
  const config = validateConfig(JSON.parse(readFileSync(outsideCheckout(configPath), 'utf8')), action !== 'archive');
  const app = JSON.parse(readFileSync(resolve(mobile, 'app.json'), 'utf8')).expo;
  if (!/^\d+\.\d+\.\d+$/.test(app.version) || !/^\d+$/.test(app.ios.buildNumber)) throw new Error('Invalid release version');
  const output = outsideCheckout(resolve(config.outputDirectory, `${app.version}-${app.ios.buildNumber}`));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const archive = resolve(output, 'BenchLedger.xcarchive');
  const exportPath = resolve(output, 'export');
  const auth = ['-authenticationKeyPath', config.keyPath, '-authenticationKeyID', config.keyId,
    '-authenticationKeyIssuerID', config.issuerId];
  const symbols = resolve(mobile, 'scripts/ios-symbols.py');
  const statusPath = resolve(output, 'release-status.json');
  const status = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : {};
  const save = (state) => writeFileSync(statusPath, JSON.stringify({ ...status, version: app.version, build: app.ios.buildNumber, ...state }, null, 2) + '\n');
  if (action === 'archive') {
    if (existsSync(archive)) throw new Error('Archive already exists; preserve it and increment the build number');
    // Regenerate from app.json so the checked version reaches the native plist.
    run('npx', ['expo', 'prebuild', '--platform', 'ios', '--no-install'], { cwd: mobile });
    run('pod', ['install'], { cwd: resolve(mobile, 'ios') });
    run('xcodebuild', ['-workspace', resolve(mobile, 'ios/BenchLedger.xcworkspace'), '-scheme', 'BenchLedger',
      '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-archivePath', archive,
      '-derivedDataPath', resolve(config.outputDirectory, 'DerivedData'), `DEVELOPMENT_TEAM=${config.teamId}`,
      '-allowProvisioningUpdates', ...auth, 'archive']);
    run('python3', [symbols, archive, '--cache', resolve(config.outputDirectory, 'symbol-cache')]);
    run('codesign', ['--verify', '--deep', '--strict', resolve(archive, 'Products/Applications/BenchLedger.app')]);
    save({ archive, archived: true, symbolsVerified: true, uploaded: false });
  } else if (action === 'export') {
    run('python3', [symbols, archive, '--verify-only']);
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
    if (!identities.toUpperCase().includes(config.distributionCertificate.toUpperCase())) {
      throw new Error('Configured distribution private key is unavailable in Keychain; no Apple account settings were changed');
    }
    const options = resolve(output, 'ExportOptions.plist');
    plist({ method: 'app-store-connect', destination: 'export', teamID: config.teamId, signingStyle: 'manual',
      signingCertificate: config.distributionCertificate, provisioningProfiles: { [app.ios.bundleIdentifier]: config.profileUuid },
      manageAppVersionAndBuildNumber: false, uploadSymbols: true, stripSwiftSymbols: true }, options);
    // Manual distribution signing avoids dependence on Xcode's GUI account session.
    run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options, '-exportPath', exportPath]);
    save({ exported: true, ipa: resolve(exportPath, 'BenchLedger.ipa') });
  } else {
    if (status.uploaded) throw new Error('Upload already recorded; check App Store Connect before retrying');
    const ipa = resolve(exportPath, 'BenchLedger.ipa');
    if (!existsSync(ipa)) throw new Error('Export the signed IPA first');
    run('python3', [symbols, archive, '--verify-only']);
    run('xcrun', ['altool', '--upload-package', ipa, '--api-key', config.keyId, '--api-issuer', config.issuerId,
      '--p8-file-path', config.keyPath, '--wait']);
    save({ uploaded: true, uploadedAt: new Date().toISOString(), processingAndTesterAvailability: 'Verify in App Store Connect' });
  }
  console.log(`BenchLedger ${app.version} (${app.ios.buildNumber}): ${action} complete`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
