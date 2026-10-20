#!/usr/bin/env python3
"""Exercise the real publisher command, replacing only the external gh process."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve()
PUBLISHER = SCRIPT.with_name("publish-sprig-rolling-release.py")
REPO = "example/buzz-fork"
ROOT = f"repos/{REPO}"
TAG = "sprig-latest"
SHA = "a" * 40
NEXT_SHA = "b" * 40


def fake_gh() -> int:
    """Stateful GitHub boundary; production branching stays in the publisher."""
    path = Path(os.environ["SPRIG_TEST_STATE"])
    state = json.loads(path.read_text())
    args = sys.argv[2:]
    payload = json.load(sys.stdin) if "--input" in args else None
    if args[0] == "api":
        method = args[args.index("--method") + 1]
        endpoint = next(arg for arg in args if arg.startswith("repos/"))
        operation = f"{method} {endpoint}"
    else:
        operation = "upload"
    state.setdefault("calls", []).append(
        {"operation": operation, "args": args, "payload": payload}
    )

    def finish(status=200, body=None, error=None):
        path.write_text(json.dumps(state))
        if "--include" in args and status is not None:
            print(f"HTTP/2.0 {status} Response\nContent-Type: application/json\n")
        if body is not None:
            print(json.dumps(body))
        if error is not None:
            print(error, file=sys.stderr)
            return 1
        return 0

    failure = state.get("failure")
    if failure and failure["operation"] == operation:
        return finish(failure["status"], error="simulated external failure")
    if operation == f"GET {ROOT}/git/ref/heads/main":
        return finish(body={"object": {"sha": state.get("main", SHA)}})
    if operation == f"GET {ROOT}/releases/tags/{TAG}":
        return (
            finish(body=state["release"])
            if state.get("release")
            else finish(404, error="release not found")
        )
    if operation == f"GET {ROOT}/git/ref/tags/{TAG}":
        return (
            finish(body={"object": {"sha": state["ref"]}})
            if state.get("ref")
            else finish(404, error="reference not found")
        )
    if operation == f"POST {ROOT}/git/refs":
        state["ref"] = payload["sha"]
    elif operation == f"PATCH {ROOT}/git/refs/tags/{TAG}":
        state["ref"] = payload["sha"]
    elif operation == f"POST {ROOT}/releases":
        if state.get("release"):
            return finish(422, error="release already exists")
        state["release"] = {"id": 42, **payload}
    elif operation == f"PATCH {ROOT}/releases/42":
        state["release"].update(payload)
    elif operation == "upload":
        if args[:3] != ["release", "upload", TAG]:
            return finish(400, error="unexpected release command")
        if args[args.index("--repo") + 1] != REPO or "--clobber" not in args:
            return finish(400, error="wrong repository or missing clobber")
        for asset in args[args.index("--clobber") + 1 :]:
            file = Path(asset)
            state.setdefault("assets", {})[file.name] = hashlib.sha256(
                file.read_bytes()
            ).hexdigest()
    else:
        return finish(400, error=f"unexpected operation: {operation}")
    return finish(body={})


class RollingReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sprig-release-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.directory = self.root / "build assets"
        self.directory.mkdir()
        for target in ("x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"):
            for suffix in ("", ".sha256"):
                (self.directory / f"sprig-{target}.tar.gz{suffix}").write_text("built asset")
        self.state_path = self.root / "state.json"
        self.save({})
        binary = self.root / "bin"
        binary.mkdir()
        if os.name == "nt":
            (binary / "gh.cmd").write_text(
                f'@"{sys.executable}" "{SCRIPT}" --fake-gh %*\n'
            )
        else:
            shim = binary / "gh"
            shim.write_text(
                f"#!{sys.executable}\n"
                "import runpy, sys\n"
                "sys.argv.insert(1, '--fake-gh')\n"
                f"runpy.run_path({str(SCRIPT)!r}, run_name='__main__')\n"
            )
            shim.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": str(binary) + os.pathsep + os.environ["PATH"],
            "SPRIG_TEST_STATE": str(self.state_path),
        }

    def save(self, state):
        self.state_path.write_text(json.dumps(state))

    def state(self):
        return json.loads(self.state_path.read_text())

    def publish(self, sha=SHA, source_policy="main"):
        return subprocess.run(
            [
                sys.executable,
                str(PUBLISHER),
                "--repo",
                REPO,
                "--sha",
                sha,
                "--assets-dir",
                str(self.directory),
                "--source-policy",
                source_policy,
            ],
            env=self.env,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
        )

    def test_first_publication_retry_and_new_build_update_same_release(self):
        for sha in (SHA, SHA, NEXT_SHA):
            with self.subTest(sha=sha):
                state = self.state()
                state["main"] = sha
                self.save(state)
                result = self.publish(sha)
                self.assertEqual(result.returncode, 0, result.stderr)
                state = self.state()
                self.assertEqual(state["ref"], sha)
                release = state["release"]
                self.assertEqual(release["target_commitish"], sha)
                self.assertEqual(release["tag_name"], TAG)
                self.assertTrue(release["prerelease"])
                self.assertFalse(release["draft"])
                self.assertEqual(release["make_latest"], "false")
                self.assertIn(sha, release["body"])
                self.assertEqual(set(state["assets"]), {p.name for p in self.directory.iterdir()})
        calls = self.state()["calls"]
        self.assertEqual(sum(c["operation"] == f"POST {ROOT}/releases" for c in calls), 1)
        self.assertEqual(sum(c["operation"] == f"POST {ROOT}/git/refs" for c in calls), 1)
        ref_updates = [c for c in calls if c["operation"] == f"PATCH {ROOT}/git/refs/tags/{TAG}"]
        self.assertEqual([c["payload"] for c in ref_updates], [{"sha": NEXT_SHA, "force": True}])

    def test_older_build_cannot_replace_newer_release_unless_explicitly_selected(self):
        self.save({"main": NEXT_SHA})
        result = self.publish(NEXT_SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        before = self.state()
        result = self.publish(SHA)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Skipped stale rolling publication", result.stdout)
        after = self.state()
        for key in ("ref", "release", "assets"):
            self.assertEqual(after[key], before[key])
        new_calls = after["calls"][len(before["calls"]) :]
        self.assertEqual(
            [call["operation"] for call in new_calls],
            [f"GET {ROOT}/git/ref/heads/main"],
        )
        result = self.publish(SHA, source_policy="selected-ref")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.state()["ref"], SHA)

    def test_orphan_tag_is_moved_before_first_release(self):
        self.save({"ref": NEXT_SHA})
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        state = self.state()
        self.assertEqual(state["ref"], SHA)
        self.assertEqual(state["release"]["target_commitish"], SHA)
        operations = [c["operation"] for c in state["calls"]]
        self.assertLess(
            operations.index(f"PATCH {ROOT}/git/refs/tags/{TAG}"),
            operations.index(f"POST {ROOT}/releases"),
        )

    def test_read_errors_never_create_or_update_remote_state(self):
        for endpoint in (
            "git/ref/heads/main",
            f"releases/tags/{TAG}",
            f"git/ref/tags/{TAG}",
        ):
            for status in (401, 403, 429, 500, None):
                with self.subTest(endpoint=endpoint, status=status):
                    self.save({"failure": {"operation": f"GET {ROOT}/{endpoint}", "status": status}})
                    result = self.publish()
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("simulated external failure", result.stderr)
                    self.assertTrue(all(c["operation"].startswith("GET ") for c in self.state()["calls"]))

    def test_write_and_upload_errors_propagate(self):
        cases = [
            ({}, f"POST {ROOT}/git/refs"),
            ({}, f"POST {ROOT}/releases"),
            ({"ref": NEXT_SHA, "release": {"id": 42}}, f"PATCH {ROOT}/git/refs/tags/{TAG}"),
            ({"ref": SHA, "release": {"id": 42}}, f"PATCH {ROOT}/releases/42"),
            ({}, "upload"),
        ]
        for initial, operation in cases:
            with self.subTest(operation=operation):
                self.save({**initial, "failure": {"operation": operation, "status": 403}})
                result = self.publish()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("simulated external failure", result.stderr)
                self.assertNotIn("Published ", result.stdout)
                self.assertEqual(self.state()["calls"][-1]["operation"], operation)

    def test_failed_first_upload_can_resume_without_duplicate_release(self):
        self.save({"failure": {"operation": "upload", "status": 500}})
        self.assertNotEqual(self.publish().returncode, 0)
        state = self.state()
        self.assertEqual(state["release"]["id"], 42)
        del state["failure"]
        self.save(state)
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.state()["calls"]
        self.assertEqual(sum(c["operation"] == f"POST {ROOT}/releases" for c in calls), 1)
        self.assertEqual(len(self.state()["assets"]), 4)

    def test_invalid_input_or_incomplete_build_never_calls_github(self):
        self.assertNotEqual(self.publish("main").returncode, 0)
        (self.directory / "sprig-aarch64-unknown-linux-musl.tar.gz.sha256").unlink()
        self.assertNotEqual(self.publish().returncode, 0)
        self.assertEqual(self.state(), {})


if __name__ == "__main__":
    if sys.argv[1:2] == ["--fake-gh"]:
        sys.exit(fake_gh())
    unittest.main()
