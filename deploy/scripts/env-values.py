#!/usr/bin/env python3
"""Compose render-ready buzz-arcadia values from a private cluster directory.

Real environment identifiers are not in this public repository. They live in
cloud-config-infrastructures, one directory per cluster on that cluster's
branch (preprd/dev-ai on `ai-dev`, prd/ai on `ai`):

  global-helm-values-patch.yaml  cluster globals every Application receives
  buzz/values.yaml               this chart's values for the environment

This prints both as one flat values file, the shape of
deploy/charts/buzz-arcadia/ci/<cluster>-values.example.yaml:

  python deploy/scripts/env-values.py <cci>/preprd/dev-ai > /secure/path/dev-ai-values.yaml
"""

import argparse
from pathlib import Path
import sys

import yaml

PATCH = "global-helm-values-patch.yaml"
VALUES = "buzz/values.yaml"
# The globals this chart reads; the patch carries others it accepts and ignores.
GLOBALS = ("account", "region", "clusterName", "infrastructure", "domainCertArn", "domainHostedZone")


class _Dumper(yaml.SafeDumper):
    # Anchors in buzz/values.yaml (rds.cidrBlocks) would otherwise come back as &id001.
    def ignore_aliases(self, data):
        return True


def cluster_globals(env_dir):
    path = env_dir / PATCH
    patch = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    parameters = (((patch.get("spec") or {}).get("source") or {}).get("helm") or {}).get("parameters") or []
    found = {item["name"]: str(item["value"]) for item in parameters if "name" in item and "value" in item}
    missing = [key for key in GLOBALS if not found.get(key)]
    if missing:
        raise ValueError(f"{path} does not set {', '.join(missing)}.")
    return {key: found[key] for key in GLOBALS}


def load(env_dir):
    env_dir = Path(env_dir)
    record = cluster_globals(env_dir)
    values = yaml.safe_load((env_dir / VALUES).read_text(encoding="utf-8")) or {}
    repeated = sorted(set(record) & set(values))
    if repeated:
        raise ValueError(
            f"{env_dir / VALUES} repeats the cluster globals {', '.join(repeated)}; "
            f"they belong in {PATCH} only."
        )
    record.update(values)
    return record


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "env_dir", type=Path,
        help="the cluster's directory in a cloud-config-infrastructures checkout, e.g. preprd/dev-ai",
    )
    args = parser.parse_args(argv)
    try:
        record = load(args.env_dir)
    except (OSError, ValueError, yaml.YAMLError) as error:
        print(f"env-values: {error}", file=sys.stderr)
        return 2
    yaml.dump(record, sys.stdout, Dumper=_Dumper, sort_keys=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
