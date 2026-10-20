#!/usr/bin/env python3
"""Create or refresh sprig-latest from the exact commit that built its assets."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

TAG = "sprig-latest"
TARGETS = ("x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl")


class PublishError(Exception):
    """A publication failed and must be retried rather than reported as success."""


def gh_run(gh: str, args: list[str], *, payload: dict | None = None):
    return subprocess.run(
        [gh, *args],
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        capture_output=True,
        timeout=300,
        check=False,
    )


def require_success(result: subprocess.CompletedProcess, operation: str) -> None:
    if result.returncode:
        raise PublishError(
            f"{operation} failed (gh exit {result.returncode}): {result.stderr.strip()}"
        )


def optional_get(gh: str, endpoint: str) -> dict | None:
    result = gh_run(gh, ["api", "--include", "--method", "GET", endpoint])
    # Only an actual HTTP 404 means absent. Authentication, rate-limit, server,
    # and transport failures must not be mistaken for a first publication.
    if result.returncode and re.match(r"HTTP/\S+ 404(?:\s|$)", result.stdout):
        return None
    require_success(result, f"GET {endpoint}")
    headers, separator, body = result.stdout.partition("\n\n")
    if not separator or not re.match(r"HTTP/\S+ 200(?:\s|$)", headers):
        raise PublishError(f"Unexpected response from GET {endpoint}")
    data = json.loads(body)
    if not isinstance(data, dict):
        raise PublishError(f"Expected an object from GET {endpoint}")
    return data


def api_write(gh: str, method: str, endpoint: str, payload: dict) -> None:
    result = gh_run(
        gh, ["api", "--method", method, endpoint, "--input", "-"], payload=payload
    )
    require_success(result, f"{method} {endpoint}")


def publish(repo: str, sha: str, directory: Path, source_policy: str) -> None:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise PublishError("--repo must be OWNER/REPO")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise PublishError("--sha must be the full build commit SHA")
    expected = [
        directory / f"sprig-{target}.tar.gz{suffix}"
        for target in TARGETS
        for suffix in ("", ".sha256")
    ]
    for asset in expected:
        if not asset.is_file() or asset.stat().st_size == 0:
            raise PublishError(f"Missing or empty build asset: {asset}")
    assets = sorted(path for path in directory.iterdir() if path.is_file())
    gh = shutil.which("gh")
    if gh is None:
        raise PublishError("GitHub CLI (gh) is required")

    root = f"repos/{repo}"
    if source_policy == "main":
        main_ref = optional_get(gh, f"{root}/git/ref/heads/main")
        current_sha = (main_ref or {}).get("object", {}).get("sha")
        if not current_sha:
            raise PublishError("Cannot establish the current main commit")
        if current_sha != sha:
            print(
                f"Skipped stale rolling publication for {sha}; "
                f"main is now {current_sha}. Build artifacts remain available."
            )
            return
    release = optional_get(gh, f"{root}/releases/tags/{TAG}")
    ref = optional_get(gh, f"{root}/git/ref/tags/{TAG}")
    if release is not None and not isinstance(release.get("id"), int):
        raise PublishError("Existing release has no numeric ID")

    # target_commitish does not move an existing tag. Update the rolling ref
    # explicitly, including recovery from a tag left by a failed first run.
    if ref is None:
        api_write(gh, "POST", f"{root}/git/refs", {"ref": f"refs/tags/{TAG}", "sha": sha})
    elif ref.get("object", {}).get("sha") != sha:
        api_write(gh, "PATCH", f"{root}/git/refs/tags/{TAG}", {"sha": sha, "force": True})

    metadata = {
        "tag_name": TAG,
        "target_commitish": sha,
        "name": "Sprig (rolling)",
        "body": (
            "Rolling Linux build of Sprig (all-in-one buzz-acp + buzz-agent + "
            f"buzz-dev-mcp), built from `{sha}`."
        ),
        "draft": False,
        "prerelease": True,
        "make_latest": "false",
    }
    if release is None:
        api_write(gh, "POST", f"{root}/releases", metadata)
    else:
        api_write(gh, "PATCH", f"{root}/releases/{release['id']}", metadata)
    # A partial upload remains a failed run. Retrying replaces matching names
    # and completes the same release, rather than creating another release.
    result = gh_run(
        gh,
        ["release", "upload", TAG, "--repo", repo, "--clobber", *map(str, assets)],
    )
    require_success(result, "Release asset upload")
    print(f"Published https://github.com/{repo}/releases/tag/{TAG} at {sha}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--assets-dir", type=Path, default=Path("dist"))
    parser.add_argument(
        "--source-policy",
        choices=("main", "selected-ref"),
        default="main",
        help="selected-ref explicitly permits a manual publication away from current main",
    )
    args = parser.parse_args()
    try:
        publish(args.repo, args.sha, args.assets_dir, args.source_policy)
    except (PublishError, OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Sprig publication failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
