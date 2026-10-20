#!/usr/bin/env python3
"""Exercise the native mobile notice packager and package verifier."""

from __future__ import annotations

import importlib.util
import json
import plistlib
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

SCRIPT = Path(__file__).resolve()
PACKAGER = SCRIPT.with_name("native-mobile-notices.py")
PODFILE_LOCK = SCRIPT.parent.parent / "mobile/ios/Podfile.lock"
SPEC = importlib.util.spec_from_file_location("native_mobile_notices", PACKAGER)
notices = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(notices)

LOCK = """PODS:
  - Flutter (1.0.0)
  - "GoogleToolboxForMac/NSData+zlib (4.2.1)":
    - GoogleToolboxForMac/Defines (= 4.2.1)
  - GoogleToolboxForMac/Defines (4.2.1)
  - url_launcher_ios (0.0.1):
    - Flutter

DEPENDENCIES:
  - Flutter (from `Flutter`)
"""


def acknowledgements(texts: dict[str, str]) -> bytes:
    specifiers = [{"Title": "Acknowledgements", "FooterText": "header"}]
    specifiers += [{"Title": name, "FooterText": text} for name, text in texts.items()]
    return plistlib.dumps({"PreferenceSpecifiers": specifiers})


class NativeMobileNoticesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.lock = self.root / "Podfile.lock"
        self.manifest = self.root / "Manifest.lock"
        self.plist = self.root / "acknowledgements.plist"
        self.flutter = self.root / "FLUTTER_LICENSE"
        self.output = self.root / "native-licenses.json"
        self.lock.write_text(LOCK, encoding="utf-8", newline="\n")
        self.manifest.write_text(LOCK, encoding="utf-8", newline="\n")
        self.flutter.write_text("Flutter BSD text\n", encoding="utf-8")

    def tearDown(self):
        self.directory.cleanup()

    def package_ios(self, texts: dict[str, str]):
        self.plist.write_bytes(acknowledgements(texts))
        return subprocess.run(
            [sys.executable, str(PACKAGER), "ios", "--lock", str(self.lock),
             "--manifest", str(self.manifest), "--acknowledgements", str(self.plist),
             "--flutter-license", str(self.flutter), "--output", str(self.output)],
            capture_output=True, text=True, check=False,
        )

    def test_checked_in_podfile_lock_parses_to_root_pods(self):
        lock = PODFILE_LOCK.read_text(encoding="utf-8").replace("\r\n", "\n")
        versions = notices.pod_versions(lock)
        self.assertEqual(versions["Flutter"], "1.0.0")
        self.assertIn("GoogleToolboxForMac", versions)
        self.assertFalse(any("/" in name for name in versions))

    def test_ios_bundle_lists_each_locked_pod_with_full_text(self):
        result = self.package_ios({
            "GoogleToolboxForMac": "Apache text",
            "url_launcher_ios": "BSD text",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        document = json.loads(self.output.read_text(encoding="utf-8"))
        self.assertEqual(document["entries"], [
            {"name": "Flutter:1.0.0 (iOS)", "text": "Flutter BSD text\n"},
            {"name": "GoogleToolboxForMac:4.2.1 (iOS)", "text": "Apache text"},
            {"name": "url_launcher_ios:0.0.1 (iOS)", "text": "BSD text"},
        ])

    def test_ios_bundle_rejects_a_pod_without_notice_text(self):
        result = self.package_ios({"GoogleToolboxForMac": "Apache text", "url_launcher_ios": " "})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("url_launcher_ios", result.stderr)
        self.assertFalse(self.output.exists())

    def test_ios_bundle_rejects_an_unsynchronized_pod_installation(self):
        self.manifest.write_text(LOCK.replace("0.0.1", "0.0.2"), encoding="utf-8")
        result = self.package_ios({"GoogleToolboxForMac": "A", "url_launcher_ios": "B"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("pod install", result.stderr)

    def test_package_check_reads_the_ipa_and_rejects_drift(self):
        self.assertEqual(self.package_ios({"GoogleToolboxForMac": "A", "url_launcher_ios": "B"}).returncode, 0)
        ipa = self.root / "Buzz.ipa"
        with zipfile.ZipFile(ipa, "w") as archive:
            archive.writestr("Payload/Runner.app/native-licenses.json", self.output.read_bytes())
        self.assertEqual(notices.check_package(ipa, self.output), 3)
        with zipfile.ZipFile(ipa, "w") as archive:
            archive.writestr("Payload/Runner.app/native-licenses.json", b"{}")
        with self.assertRaisesRegex(ValueError, "differ"):
            notices.check_package(ipa, self.output)

    def test_package_check_reads_android_aboutlibraries_resource(self):
        document = {
            "libraries": [
                {"uniqueId": "androidx.core:core", "artifactVersion": "1.0",
                 "licenses": ["Apache-2.0"]},
                {"uniqueId": "com.google.mlkit:common", "artifactVersion": "18.11.0",
                 "licenses": ["mlkit"]},
            ],
            "licenses": {
                "Apache-2.0": {"content": "Apache text"},
                "mlkit": {"name": "ML Kit Terms of Service",
                          "url": "https://developers.google.com/ml-kit/terms"},
            },
        }
        expected = self.root / "aboutlibraries.json"
        expected.write_text(json.dumps(document), encoding="utf-8")
        apk = self.root / "app.apk"
        with zipfile.ZipFile(apk, "w") as archive:
            archive.writestr("res/raw/aboutlibraries.json", expected.read_bytes())
        self.assertEqual(notices.check_package(apk, expected), 2)
        self.assertEqual(notices.android_entries(document)[1]["text"],
                         "ML Kit Terms of Service\nhttps://developers.google.com/ml-kit/terms")
        document["licenses"]["Apache-2.0"]["content"] = ""
        expected.write_text(json.dumps(document), encoding="utf-8")
        with zipfile.ZipFile(apk, "w") as archive:
            archive.writestr("res/raw/aboutlibraries.json", expected.read_bytes())
        with self.assertRaisesRegex(ValueError, "androidx.core:core"):
            notices.check_package(apk, expected)


if __name__ == "__main__":
    unittest.main()
