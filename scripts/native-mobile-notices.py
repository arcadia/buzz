#!/usr/bin/env python3
"""Package native mobile notices and verify the bytes in an APK/AAB/IPA/app.

CocoaPods is the source of iOS notice text. AboutLibraries is the Android
collector. An SPDX name is never a substitute for notice text; only terms that
publish no text (proprietary SDK terms) are listed by name and URL.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import plistlib
import re
import zipfile
from pathlib import Path


def pod_versions(lock: str) -> dict[str, str]:
    """Read CocoaPods' stable top-level PODS entries, including quoted subspecs."""
    section = lock.split("PODS:\n", 1)[1].split("\n\n", 1)[0]
    versions: dict[str, str] = {}
    for line in section.splitlines():
        if not line.startswith("  - "):
            continue
        match = re.fullmatch(r'  - "?(.+?) \(([^()]+)\)"?:?', line)
        if not match:
            raise ValueError(f"Unrecognized locked pod: {line}")
        name, version = match.groups()
        name = name.split("/", 1)[0]
        if name in versions and versions[name] != version:
            raise ValueError(f"Conflicting locked versions for {name}")
        versions[name] = version
    if not versions:
        raise ValueError("Podfile.lock has no resolved dependencies")
    return versions


def ios_notices(lock: Path, manifest: Path, acknowledgements: Path,
                flutter_license: Path) -> dict:
    locked = lock.read_bytes()
    if locked != manifest.read_bytes():
        raise ValueError("CocoaPods installation does not match Podfile.lock; run pod install")
    versions = pod_versions(locked.decode("utf-8").replace("\r\n", "\n"))
    plist = plistlib.loads(acknowledgements.read_bytes())
    notices = {
        item["Title"]: item.get("FooterText", "")
        for item in plist["PreferenceSpecifiers"]
        if item.get("Title") in versions
    }
    # Flutter's generated local podspec is a 1.0.0 shim without a license file.
    # Use the actual build SDK license; Flutter also packages its engine notices.
    if "Flutter" in versions and not notices.get("Flutter", "").strip():
        notices["Flutter"] = flutter_license.read_text(encoding="utf-8")
    missing = sorted(name for name in versions if not notices.get(name, "").strip())
    if missing:
        raise ValueError("Missing CocoaPods notice text: " + ", ".join(missing))
    return {
        "format": 1,
        "podfileLockSha256": hashlib.sha256(locked).hexdigest(),
        "acknowledgementsSha256": hashlib.sha256(acknowledgements.read_bytes()).hexdigest(),
        "entries": [
            {"name": f"{name}:{versions[name]} (iOS)", "text": notices[name]}
            for name in sorted(versions)
        ],
    }


def android_entries(document: dict) -> list[dict[str, str]]:
    libraries = document["libraries"]
    licenses = document["licenses"]
    if not libraries:
        raise ValueError("Native Android notices are empty")
    entries = []
    for library in libraries:
        name = f"{library['uniqueId']}:{library['artifactVersion']}"
        texts = []
        for key in library.get("licenses", []):
            license_entry = licenses[key]
            text = license_entry.get("content", "")
            if not text.strip() and license_entry.get("url", "").strip():
                text = f"{license_entry.get('name', key)}\n{license_entry['url']}"
            texts.append(text)
        if not texts or any(not text.strip() for text in texts):
            raise ValueError(f"Missing Android notice text: {name}")
        entries.append({"name": name, "text": "\n\n".join(texts)})
    return entries


def package_notices(package: Path) -> tuple[str, bytes]:
    """Read an uncompressed resource, rather than accepting a source-tree file."""
    if package.is_dir():
        candidates = list(package.glob("native-licenses.json"))
        if len(candidates) != 1:
            raise ValueError("App bundle must contain native-licenses.json")
        return "ios", candidates[0].read_bytes()
    with zipfile.ZipFile(package) as archive:
        names = archive.namelist()
        ios = [name for name in names if re.fullmatch(
            r"Payload/[^/]+\.app/native-licenses\.json", name)]
        android = [name for name in names if name in (
            "res/raw/aboutlibraries.json", "base/res/raw/aboutlibraries.json")]
        candidates = ios + android
        if len(candidates) != 1:
            raise ValueError("Package must contain exactly one native notice resource")
        return ("ios" if ios else "android"), archive.read(candidates[0])


def check_package(package: Path, expected: Path) -> int:
    platform, data = package_notices(package)
    if data != expected.read_bytes():
        raise ValueError("Packaged native notices differ from this build's generated notices")
    document = json.loads(data)
    entries = android_entries(document) if platform == "android" else document["entries"]
    if not entries or any(not e["name"].strip() or not e["text"].strip() for e in entries):
        raise ValueError("Packaged native notices are incomplete")
    return len(entries)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    ios = commands.add_parser("ios")
    for flag in ("lock", "manifest", "acknowledgements", "flutter-license", "output"):
        ios.add_argument("--" + flag, required=True, type=Path)
    check = commands.add_parser("check-package")
    check.add_argument("package", type=Path)
    check.add_argument("--expected", required=True, type=Path)
    args = parser.parse_args()
    if args.command == "ios":
        document = ios_notices(args.lock, args.manifest, args.acknowledgements,
                               args.flutter_license)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        # Xcode's /usr/bin/python3 is 3.9, whose Path.write_text has no newline argument.
        args.output.write_bytes(
            (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        print(f"Packaged notices for {len(document['entries'])} locked CocoaPods dependencies")
    else:
        count = check_package(args.package, args.expected)
        print(f"Verified {count} native dependency notices in {args.package.name}")


if __name__ == "__main__":
    main()
