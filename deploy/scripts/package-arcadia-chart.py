#!/usr/bin/env python3
"""Package the current upstream chart and locked dependencies for offline Argo."""

from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
CHARTS = ROOT / "deploy/charts"


def run(*args):
    subprocess.run(["helm", *map(str, args)], check=True, timeout=180)


def main():
    # Never edit the shared upstream source or resolve newer optional versions.
    with tempfile.TemporaryDirectory(prefix="buzz-arcadia-chart-") as temporary:
        stage = Path(temporary)
        upstream = stage / "buzz"
        shutil.copytree(CHARTS / "buzz", upstream, ignore=shutil.ignore_patterns("charts"))
        lock_before = (upstream / "Chart.lock").read_bytes()
        run("dependency", "build", upstream, "--skip-refresh")
        if (upstream / "Chart.lock").read_bytes() != lock_before:
            raise RuntimeError("Upstream dependency build changed its reviewed lock")
        wrapper = stage / "buzz-arcadia"
        wrapper.mkdir()
        shutil.copyfile(CHARTS / "buzz-arcadia/Chart.yaml", wrapper / "Chart.yaml")
        run("dependency", "update", wrapper, "--skip-refresh")
        packages = list((wrapper / "charts").glob("buzz-*.tgz"))
        if len(packages) != 1:
            raise RuntimeError("Expected exactly one packaged upstream chart")
        destination = CHARTS / "buzz-arcadia/charts"
        destination.mkdir(exist_ok=True)
        shutil.copyfile(packages[0], destination / packages[0].name)
        shutil.copyfile(wrapper / "Chart.lock", CHARTS / "buzz-arcadia/Chart.lock")
        print(f"Packaged {destination / packages[0].name}; review and commit it with Chart.lock")


if __name__ == "__main__":
    main()
