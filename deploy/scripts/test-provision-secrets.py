#!/usr/bin/env python3
"""Run provision-secrets.sh against stub aws/buzz-admin binaries; no AWS access."""

from pathlib import Path
import os
import shutil
import subprocess
import tempfile
import unittest

import yaml

SCRIPT = Path(__file__).with_name("provision-secrets.sh")
ENVIRONMENT_FILE = sorted((SCRIPT.parents[1] / "charts/buzz-arcadia/ci").glob("*-values.example.yaml"))[0]
ENVIRONMENT = yaml.safe_load(ENVIRONMENT_FILE.read_text(encoding="utf-8"))
CLUSTER, ACCOUNT = ENVIRONMENT["clusterName"], str(ENVIRONMENT["account"])
PREFIX = f"/{ENVIRONMENT['infrastructure']}/{CLUSTER}/buzz"
# The record the script reads: a cloud-config-infrastructures cluster directory's
# global-helm-values-patch.yaml, in the shape that repository writes it.
PATCH = f"""apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ignored
spec:
  source:
    helm:
      parameters:
        - name: account
          value: "{ACCOUNT}"
        - name: region
          value: "{ENVIRONMENT['region']}"
        - name: clusterName
          value: "{CLUSTER}"
        - name: infrastructure
          value: {ENVIRONMENT['infrastructure']}  # SSM path segment
        - name: argocdNamespace
          value: "argocd"
"""
# PATH lookup, not the platform default: Windows resolves a bare "bash" to WSL first.
BASH = shutil.which("bash") or "bash"

# Parameters live as files under $STUB_STATE, named by their path with / -> _.
AWS_STUB = r"""#!/usr/bin/env bash
set -euo pipefail
service="" action="" name="" type="" value="" query=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --type) type="$2"; shift 2 ;;
    --value) value="$2"; shift 2 ;;
    --query) query="$2"; shift 2 ;;
    --region|--profile|--output) shift 2 ;;
    --*) shift ;;
    *) if [ -z "$service" ]; then service="$1"; else action="${action:-$1}"; fi; shift ;;
  esac
done
file="${STUB_STATE}/$(printf '%s' "$name" | tr '/' '_')"
case "${service} ${action}" in
  "sts get-caller-identity") printf '%s\n' "$STUB_ACCOUNT" ;;
  "ssm put-parameter")
    if [ -n "${STUB_PUT_ERROR:-}" ]; then echo "$STUB_PUT_ERROR" >&2; exit 254; fi
    if [ -e "$file" ]; then
      echo "An error occurred (ParameterAlreadyExists) when calling the PutParameter operation" >&2
      exit 254
    fi
    printf '%s\n' "$type" > "$file"
    cat "${value#file://}" >> "$file" ;;
  "ssm get-parameter")
    [ -e "$file" ] || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; }
    if [ "$query" = Parameter.Type ]; then head -n 1 "$file"; else tail -n +2 "$file"; echo; fi ;;
  *) echo "unexpected aws call: ${service} ${action}" >&2; exit 99 ;;
esac
"""

ADMIN_STUB = r"""#!/usr/bin/env bash
set -euo pipefail
count_file="${STUB_STATE}/.keys"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
printf 'Public key: %064x\nSecret key: %064x\n' "$n" "$(( n + 1000 ))"
"""


class ProvisionSecretsTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.directory, ignore_errors=True)
        self.state = self.directory / "state"
        self.state.mkdir()
        self.cluster_dir = self.directory / "cci" / CLUSTER
        self.cluster_dir.mkdir(parents=True)
        (self.cluster_dir / "global-helm-values-patch.yaml").write_text(PATCH, encoding="utf-8", newline="\r\n")
        bin_dir = self.directory / "bin"
        bin_dir.mkdir()
        for name, body in (("aws", AWS_STUB), ("buzz-admin", ADMIN_STUB)):
            stub = bin_dir / name
            stub.write_text(body, encoding="utf-8", newline="\n")
            stub.chmod(0o755)
        self.env = {
            **os.environ,
            "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
            "STUB_STATE": str(self.state),
            "STUB_ACCOUNT": ACCOUNT,
            "ARIA_FRONTEND_REPO": str(self.directory / "no-bridge-checkout"),
            "BUZZ_ENV_DIR": self.cluster_dir.as_posix(),
            "TMPDIR": str(self.directory),
        }

    def run_script(self, *args, **env):
        return subprocess.run(
            [BASH, SCRIPT.as_posix(), *args], env={**self.env, **env},
            text=True, capture_output=True, timeout=300, check=False,
        )

    def stored(self, tail):
        return self.state / f"{PREFIX}/{tail}".replace("/", "_")

    def test_apply_creates_every_parameter_and_verify_passes(self):
        result = self.run_script("--apply", CLUSTER, "--agents", "aria")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("owner secret key:", result.stdout)
        for tail in ("relay-private-key", "git-hook-hmac", "redis-password", "owner-pubkey",
                     "agent-key-aria", "aria-db-password"):
            self.assertTrue(self.stored(tail).exists(), tail)
        for tail in ("aria-bot-api-token", "arcadia-docs-mcp-token",
                     "aria-orchestrator-token", "pilot-allowlist"):
            self.stored(tail).write_text("SecureString\nexternally-authored\n", encoding="utf-8")
        verify = self.run_script("--verify", CLUSTER)
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)

    def test_rerun_never_reports_keys_it_did_not_store(self):
        self.assertEqual(self.run_script("--apply", CLUSTER).returncode, 0)
        before = {path.name: path.read_text() for path in self.state.iterdir()}
        result = self.run_script("--apply", CLUSTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("owner secret key:", result.stdout)
        self.assertNotIn("relay pubkey", result.stdout)
        self.assertNotIn("pubkey:", result.stdout)
        self.assertIn("no new owner secret was issued", result.stdout)
        after = {path.name: path.read_text() for path in self.state.iterdir() if path.name != ".keys"}
        self.assertEqual(after, {name: text for name, text in before.items() if name != ".keys"})

    def test_a_failed_write_is_an_error_not_an_existing_parameter(self):
        result = self.run_script(
            "--apply", CLUSTER, "--scope", "relay",
            STUB_PUT_ERROR="An error occurred (AccessDeniedException) when calling PutParameter",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("AccessDeniedException", result.stderr)
        self.assertNotIn("exists", result.stdout)
        self.assertNotIn("owner secret key:", result.stdout)

    def test_plan_reads_the_private_record(self):
        result = self.run_script("--plan", CLUSTER, "--scope", "relay")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"account {ACCOUNT}, prefix {PREFIX})", result.stdout)
        self.assertIn(f"--name {PREFIX}/relay-private-key", result.stdout)

    def test_wrong_account_and_unknown_cluster_are_refused_before_any_write(self):
        result = self.run_script("--apply", CLUSTER, STUB_ACCOUNT="000000000000")
        self.assertEqual(result.returncode, 2)
        self.assertIn(f"{CLUSTER} is {ACCOUNT}", result.stderr)
        self.assertEqual(list(self.state.iterdir()), [])
        result = self.run_script("--plan", "no-such-cluster")
        self.assertEqual(result.returncode, 2)
        self.assertIn(f"record for cluster '{CLUSTER}', not 'no-such-cluster'", result.stderr)
        for directory in ("", str(self.directory / "missing")):
            result = self.run_script("--plan", CLUSTER, BUZZ_ENV_DIR=directory)
            self.assertEqual(result.returncode, 2)
            self.assertIn("no environment record", result.stderr)


if __name__ == "__main__":
    unittest.main()
