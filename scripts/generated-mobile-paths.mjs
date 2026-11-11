import { execFileSync } from "node:child_process";

// Expo Continuous Native Generation produces local build projects, not source.
// Never let this exception hide a tracked native file from the public checks.
export function generatedMobilePaths(root) {
  const paths = ["apps/mobile/ios", "apps/mobile/android", "apps/mobile/.expo"];
  try {
    const tracked = execFileSync("git", ["ls-files", "--", ...paths], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (tracked) return new Set();
    return new Set(paths);
  } catch { return new Set(); }
}
