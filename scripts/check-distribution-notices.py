#!/usr/bin/env python3
"""Verify generated native notices without cargo-about or network access."""

import hashlib
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent.parent


def check(root=ROOT):
    lines = (root / "licenses/native-inputs.sha256").read_text(encoding="utf-8").splitlines()
    if not lines:
        raise ValueError("Empty native notices checksum manifest")
    for line in lines:
        match = re.fullmatch(r"([a-f0-9]{64})  (.+)", line)
        if match is None:
            raise ValueError("Invalid native notices checksum manifest")
        expected, relative = match.groups()
        content = (root / relative).read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(content).hexdigest() != expected:
            raise ValueError(
                f"Distribution notices are stale ({relative}). "
                "Run python scripts/generate-distribution-notices.py."
            )


if __name__ == "__main__":
    check()
