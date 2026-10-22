# Distribution notices

Buzz is derived from [block/buzz](https://github.com/block/buzz). The root
`LICENSE` preserves its Apache-2.0 terms. Arcadia's source changes are recorded
in [arcadia/buzz](https://github.com/arcadia/buzz). No source license has been
replaced by the notices collected here.

This packaging work supports **Arcadia internal use**. It is not a declaration
that an installer is cleared for redistribution outside Arcadia.

## What is packaged

| Artifact | Notice source and build integration |
| --- | --- |
| Desktop frontend | Vite 8's `build.license` collects the actual emitted dependency graph and full texts into `dist/licenses/frontend-dependencies.txt`. This includes the npm font packages. `public/pow/LICENSE.txt` also remains in the frontend assets. |
| Desktop native app and sidecars | `desktop-native.txt` contains Cargo dependency licenses, copyright notices, versions and source links. Tauri's shared resource configuration puts this file, the root `LICENSE`, this document, `speech-native.txt` and the Pocket voice attribution in every Linux, macOS and Windows bundle. Release/canary configuration overlays retain these resources. |
| Speech SDK | `speech-native.txt` adds the native SDK dependencies that Cargo cannot discover. `speech/sources.json` records the upstream license URLs, revisions and checksums. These follow the CMake sources of sherpa-onnx 1.13.4, including ONNX Runtime, eSpeak NG, Piper phonemize, Eigen, Kaldi, OpenFST and supporting libraries. |
| Sprig archives | `build-sprig.sh` includes `LICENSE`, `licenses/sprig-native.txt` and this document in each tarball. The Sprig graph does not include the desktop speech SDK. |
| Flutter Android/iOS | Flutter's normal license collector embeds dependency `LICENSE`/`NOTICES` files. The generated `mobile/NOTICES` adds Buzz, Inter, Tabler, Geist Mono and the projected emoji-mart data. Native dependencies are collected per build: the AboutLibraries Gradle plugin writes the Android variant's Maven notices to `res/raw/aboutlibraries.json`, and the Runner target's *Package Native Notices* build phase runs `scripts/native-mobile-notices.py ios` to copy the CocoaPods acknowledgement text for every pod in `Podfile.lock` into `native-licenses.json`. Settings → Open source licenses opens Flutter's standard viewer for the combined set; a missing or incomplete native bundle appears as an explicit entry instead of being omitted. |

The native Cargo notice set is a **union**, retaining build dependencies and
platform-specific packages. It covers the desktop's default and `mesh-llm`
features on x86_64 Linux GNU, x86_64/arm64 macOS and x86_64 Windows MSVC; the
default sidecar roots; and Sprig's x86_64/arm64 Linux musl targets. A notice may
therefore appear for a component omitted from one particular executable.
Sprig supplies the ACP, agent, dev-MCP, CLI and Git-helper dependency roots;
the desktop-only Kubernetes backend is scanned separately.

## Regeneration and checks

Use Python 3.10+ and the pinned scanner:

```sh
cargo install cargo-about --version 0.9.2 --locked --features cli
python scripts/generate-distribution-notices.py
python scripts/check-distribution-notices.py
```

Commit the generated texts and checksum manifest with dependency updates.
CI, desktop Vite builds and Sprig packaging reject changed Cargo manifests,
lockfiles, scanner policy, collected speech texts or generated native output.
Review the speech SDK's native dependency pins when its version changes;
generation rejects a wrapper version that differs from `speech/sources.json`.
The checked-in license texts can be verified against their pinned source URLs.

For mobile asset-only updates:

```sh
python scripts/generate-distribution-notices.py --mobile-only
cd mobile && flutter test test/distribution_notices_test.dart
```

`mobile/NOTICES` uses Flutter's package-header/separator format; do not replace it
with a list of SPDX identifiers. The license test compares full canonical
texts. When the emoji dataset changes, update its copied MIT text and version
alongside the dataset. Inter's documented character-map changes remain attributed
in `mobile/assets/fonts/README.md`.

## Source availability and remaining boundaries

The Cargo notices include exact registry source archive URLs (including every
MPL-2.0 crate), or pinned Git source links, so recipients can obtain the
unmodified covered source. The SDK notice records its additional native source
pins. These links are **not** a complete corresponding-source delivery or a
written source offer for a combined GPL executable.

The sherpa-onnx Rust wrapper is Apache-2.0, but its default prebuilt static link
set includes the GPLv3 eSpeak NG library. Buzz currently uses its speech
recognizer API. Whether particular eSpeak object files survive linker dead
stripping must be checked on the final platform binary; the notices preserve its
terms conservatively. External distribution requires a separate assessment of
the actual linked output, complete corresponding source and applicable terms.

Flutter's collector covers Dart packages, plugin-root notices and the Flutter
engine's third-party notices. The native collectors report what Maven POMs and
CocoaPods podspecs declare; they are **not an independent audit of every
transitive Maven/CocoaPods binary**. AboutLibraries fetches some Android texts
from each project's default branch at build time, and proprietary SDK terms
that publish no text (Google Play services, ML Kit) are listed by name and URL.
Check a built package's native notices against that build's generated JSON:

```sh
python scripts/native-mobile-notices.py check-package app-release.aab \
  --expected mobile/build/app/generated/aboutLibraries/release/res/raw/aboutlibraries.json
python scripts/native-mobile-notices.py check-package Buzz.ipa \
  --expected mobile/build/ios/iphoneos/Runner.app/native-licenses.json
```

Native SDK/OS redistributables and their source-delivery requirements still need
artifact-level review before external distribution.

Models, voice samples and tools downloaded at runtime are not all installer
contents. The shipped Pocket VCTK samples retain their CC BY 4.0 attribution,
source revision, per-file hashes and enhancement attribution in
`pocket-voices-NOTICE.md` in the desktop bundle. Other downloaded model/tool
licenses must be retained and reviewed with those downloads; this collector does
not assert coverage for them.
