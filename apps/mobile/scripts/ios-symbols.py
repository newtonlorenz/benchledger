#!/usr/bin/env python3
"""Install upstream Release dSYMs and verify every archived executable's UUIDs."""
import argparse
import hashlib
import json
import plistlib
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
VERSION = re.compile(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\Z")
UUID = re.compile(r"UUID: ([0-9A-Fa-f-]{36}) \(([^)]+)\)")


def uuids(binary):
    output = subprocess.check_output(["xcrun", "dwarfdump", "--uuid", str(binary)], text=True)
    result = {(u.upper(), arch) for u, arch in UUID.findall(output)}
    if not result:
        raise ValueError(f"No Mach-O UUIDs: {binary.name}")
    return result


def symbol_urls(react, hermes):
    if not VERSION.fullmatch(react) or not VERSION.fullmatch(hermes):
        raise ValueError("Only pinned release versions are supported")
    base = "https://repo.maven.apache.org/maven2/com/facebook"
    return [
        f"{base}/react/react-native-artifacts/{react}/react-native-artifacts-{react}-reactnative-{kind}-dSYM-release.tar.gz"
        for kind in ("core", "dependencies")
    ] + [f"{base}/hermes/hermes-ios/{hermes}/hermes-ios-{hermes}-hermes-framework-dSYM-release.tar.gz"]


def safe_member(member):
    path = Path(member.name)
    if path.is_absolute() or ".." in path.parts or member.issym() or member.islnk():
        raise ValueError("Unsafe path or link in symbol download")
    return (member.isfile() or member.isdir()) and any(p.endswith(".dSYM") for p in path.parts)


def download(url, destination):
    # The publisher's SHA-256 catches incomplete/corrupted cache files. UUID
    # matching below independently binds symbols to the actual shipped binary.
    with urllib.request.urlopen(url + ".sha256", timeout=60) as response:
        expected = response.read().decode().strip().split()[0].lower()
    if not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise ValueError("Invalid publisher checksum")
    target = destination / url.rsplit("/", 1)[1]
    def digest(path):
        with path.open("rb") as source:
            return hashlib.file_digest(source, "sha256").hexdigest()
    if not target.exists() or digest(target) != expected:
        partial = target.with_suffix(".partial")
        subprocess.run(["curl", "--fail", "--silent", "--show-error", "--location",
                        "--proto", "=https", "--proto-redir", "=https", "--retry", "2",
                        "--max-time", "300", "--output", str(partial), url], check=True)
        if digest(partial) != expected:
            raise ValueError("Symbol archive checksum mismatch")
        partial.replace(target)
    return target, expected


def executable(bundle):
    info = plistlib.loads((bundle / "Info.plist").read_bytes())
    name = info["CFBundleExecutable"]
    if Path(name).name != name:
        raise ValueError("Invalid executable name")
    return bundle / name


def validate_archive(archive):
    apps = list((archive / "Products/Applications").glob("*.app"))
    if len(apps) != 1:
        raise ValueError("Expected one archived application")
    app = apps[0]
    identifier = plistlib.loads((app / "Info.plist").read_bytes())["CFBundleIdentifier"]
    expected = json.loads((ROOT / "apps/mobile/app.json").read_text())["expo"]["ios"]["bundleIdentifier"]
    if identifier != expected:
        raise ValueError("Archive does not belong to BenchLedger")
    return app


def verify(archive):
    app = validate_archive(archive)
    symbols = list((archive / "dSYMs").glob("*.dSYM"))
    available = set().union(*(uuids(path) for path in symbols)) if symbols else set()
    binaries = [executable(app)] + [executable(p) for p in (app / "Frameworks").glob("*.framework")]
    report = []
    for binary in binaries:
        required = uuids(binary)
        missing = required - available
        if missing:
            raise ValueError(f"Missing dSYM for {binary.name}: {sorted(missing)}")
        report.append({"binary": binary.name, "uuids": sorted(required)})
    return report


def install(archive, cache):
    app = validate_archive(archive)
    react_package = json.loads((ROOT / "node_modules/react-native/package.json").read_text())
    hermes_pod = json.loads((ROOT / "apps/mobile/ios/Pods/Local Podspecs/hermes-engine.podspec.json").read_text())
    urls = symbol_urls(react_package["version"], hermes_pod["version"])
    wanted = {name: uuids(app / "Frameworks" / f"{name}.framework" / name)
              for name in ("React", "ReactNativeDependencies", "hermesvm")}
    cache.mkdir(parents=True, exist_ok=True, mode=0o700)
    sources = []
    for url in urls:
        print(f"Checking {url.rsplit('/', 1)[1]}", flush=True)
        tarball, checksum = download(url, cache)
        sources.append({"url": url, "sha256": checksum})
        with tempfile.TemporaryDirectory(dir=cache) as temp:
            with tarfile.open(tarball) as source:
                for member in source:
                    if safe_member(member):
                        source.extract(member, temp, filter="data")
            for candidate in Path(temp).rglob("*.dSYM"):
                dwarf_files = list((candidate / "Contents/Resources/DWARF").glob("*"))
                if len(dwarf_files) != 1 or dwarf_files[0].name not in wanted:
                    continue
                name = dwarf_files[0].name
                if not wanted[name].issubset(uuids(candidate)):
                    continue
                # An empty dsymutil shell can have a UUID but no debugging data.
                info = subprocess.check_output(["xcrun", "dwarfdump", "--debug-info", "--recurse-depth=0", str(candidate)], text=True)
                if "DW_TAG_compile_unit" not in info:
                    raise ValueError(f"No debug information in {candidate.name}")
                target = archive / "dSYMs" / candidate.name
                if target.exists():
                    if not wanted[name].issubset(uuids(target)):
                        raise ValueError(f"Conflicting existing symbols: {target.name}")
                else:
                    shutil.copytree(candidate, target)
                print(f"Matched {name}: {sorted(wanted[name])}", flush=True)
    return {"sources": sources, "executables": verify(archive)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    archive = args.archive.resolve(strict=True)
    if archive.is_relative_to(ROOT):
        parser.error("Release archives must be outside the public checkout")
    if args.verify_only:
        result = {"executables": verify(archive)}
    else:
        if args.cache is None or args.cache.resolve().is_relative_to(ROOT):
            parser.error("Supply a symbol cache outside the public checkout")
        result = install(archive, args.cache.resolve())
    if not args.verify_only:
        (archive.parent / f"{archive.stem}-symbols.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"Verified dSYMs for {len(result['executables'])} executables")


if __name__ == "__main__":
    main()
