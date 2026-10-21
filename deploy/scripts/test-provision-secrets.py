#!/usr/bin/env python3
"""Run provision-secrets.sh against stub aws/buzz-admin binaries; no AWS access."""

from pathlib import Path
import os
import shutil
import stat
import subprocess
import tempfile
import unittest

import yaml

SCRIPT = Path(__file__).with_name("provision-secrets.sh")
REPO_ROOT = SCRIPT.resolve().parents[2]
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
    path="${value#file://}"
    # aws.exe cannot open a POSIX path such as file:///tmp/...; it only reads the
    # native form, which the cygpath stub below marks with STUB_NATIVE_PREFIX.
    if [ -n "${STUB_NATIVE_PREFIX:-}" ]; then
      case "$path" in
        "$STUB_NATIVE_PREFIX"*) path="${path#"$STUB_NATIVE_PREFIX"}" ;;
        *) echo "Error parsing parameter '--value': Unable to load paramfile ${value}: [Errno 2] No such file or directory: '${path}'" >&2
           exit 252 ;;
      esac
    fi
    if [ -n "${STUB_PUT_ERROR:-}" ] && [[ "$name" == *"${STUB_PUT_ERROR_TAIL:-}" ]]; then
      echo "$STUB_PUT_ERROR" >&2; exit 254
    fi
    if [ -e "$file" ]; then
      echo "An error occurred (ParameterAlreadyExists) when calling the PutParameter operation" >&2
      exit 254
    fi
    printf '%s\n' "$type" > "$file"
    cat "$path" >> "$file" ;;
  "ssm get-parameter")
    [ -e "$file" ] || { echo "An error occurred (ParameterNotFound)" >&2; exit 254; }
    if [ "$query" = Parameter.Type ]; then head -n 1 "$file"; else tail -n +2 "$file"; echo; fi ;;
  *) echo "unexpected aws call: ${service} ${action}" >&2; exit 99 ;;
esac
"""

# `cygpath -m` as Git Bash provides it: paths under STUB_NATIVE_ROOT gain a drive-style
# prefix that only the AWS stub accepts. Both sides go through the real cygpath first
# (Git Bash's mktemp hands back /c/... for a C:/... TMPDIR); anywhere else there is none.
CYGPATH_STUB = r"""#!/usr/bin/env bash
[ "$1" = "-m" ] || exit 64
mixed() { if [ -x /usr/bin/cygpath ]; then /usr/bin/cygpath -m "$1"; else printf '%s\n' "$1"; fi; }
path="$(mixed "$2")"
root="$(mixed "$STUB_NATIVE_ROOT")"
case "$path" in
  "$root"/*) printf '%s%s\n' "$STUB_NATIVE_PREFIX" "$path" ;;
  *) printf '%s\n' "$path" ;;
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
        self.tmp = self.directory / "tmp"
        self.tmp.mkdir()
        self.home = self.directory / "home"
        self.home.mkdir()
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
            "BUZZ_OWNER_KEY_FILE": "",
            "TMPDIR": self.tmp.as_posix(),
            "HOME": self.home.as_posix(),
        }
        self.default_owner_key = self.home / ".buzz" / f"owner-key-{CLUSTER}.hex"

    def run_script(self, *args, **env):
        return subprocess.run(
            [BASH, SCRIPT.as_posix(), *args], env={**self.env, **env},
            text=True, capture_output=True, timeout=300, check=False,
        )

    def stored(self, tail):
        return self.state / f"{PREFIX}/{tail}".replace("/", "_")

    def secure_values(self):
        """Every SecureString this run stored, keyed by parameter file name."""
        values = {}
        for path in self.state.iterdir():
            if path.name == ".keys":
                continue
            kind, _, value = path.read_text(encoding="utf-8").partition("\n")
            if kind == "SecureString":
                values[path.name] = value.strip()
        return values

    def owner_secret(self, path):
        """The owner secret from its key file, with the public key the buzz-admin stub paired to it."""
        secret = path.read_text(encoding="utf-8").strip()
        self.assertRegex(secret, r"^[0-9a-f]{64}$")
        return secret, f"{int(secret, 16) - 1000:064x}"

    def assert_no_secret_printed(self, result):
        output = result.stdout + result.stderr
        secrets = self.secure_values()
        self.assertTrue(secrets)
        for name, value in secrets.items():
            self.assertNotIn(value, output, name)
        if self.default_owner_key.exists():
            self.assertNotIn(self.owner_secret(self.default_owner_key)[0], output)

    def test_apply_creates_every_parameter_and_verify_passes(self):
        result = self.run_script("--apply", CLUSTER, "--agents", "aria")
        self.assertEqual(result.returncode, 0, result.stderr)
        for tail in ("relay-private-key", "git-hook-hmac", "redis-password", "owner-pubkey",
                     "agent-key-aria", "aria-db-password"):
            self.assertTrue(self.stored(tail).exists(), tail)
        for tail in ("aria-bot-api-token", "arcadia-docs-mcp-token",
                     "aria-orchestrator-token", "pilot-allowlist"):
            self.stored(tail).write_text("SecureString\nexternally-authored\n", encoding="utf-8")
        verify = self.run_script("--verify", CLUSTER)
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)

    def test_owner_secret_goes_to_a_private_file_and_only_its_path_and_public_key_are_printed(self):
        result = self.run_script("--apply", CLUSTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        _, owner_pub = self.owner_secret(self.default_owner_key)
        self.assertEqual(self.stored("owner-pubkey").read_text(encoding="utf-8").split()[1], owner_pub)
        self.assertIn(f"buzz.ownerPubkey: {owner_pub}", result.stdout)
        self.assertIn(self.default_owner_key.name, result.stdout)
        self.assert_no_secret_printed(result)
        self.assertEqual([path.name for path in self.default_owner_key.parent.iterdir()],
                         [self.default_owner_key.name])
        if os.name == "posix":
            self.assertEqual(stat.S_IMODE(self.default_owner_key.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.default_owner_key.parent.stat().st_mode), 0o700)

    def test_owner_key_file_can_be_chosen_and_its_directory_is_created(self):
        target = self.directory / "vault" / "nested" / "owner.hex"
        result = self.run_script("--apply", CLUSTER, "--owner-key-file", target.as_posix())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.owner_secret(target)
        self.assertIn("owner.hex", result.stdout)
        self.assertFalse(self.default_owner_key.exists())
        env_result = self.run_script("--apply", "--scope", "relay", CLUSTER,
                                     BUZZ_OWNER_KEY_FILE=(self.directory / "other.hex").as_posix())
        self.assertEqual(env_result.returncode, 0, env_result.stderr)
        self.assertIn("no new owner secret was issued", env_result.stdout)
        self.assertFalse((self.directory / "other.hex").exists())

    def test_rerun_never_reports_keys_it_did_not_store(self):
        self.assertEqual(self.run_script("--apply", CLUSTER).returncode, 0)
        before = {path.name: path.read_text() for path in self.state.iterdir()}
        owner_key = self.default_owner_key.read_text(encoding="utf-8")
        result = self.run_script("--apply", CLUSTER)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(self.default_owner_key.name, result.stdout)
        self.assertNotIn("relay pubkey", result.stdout)
        self.assertNotIn("pubkey:", result.stdout)
        self.assertIn("no new owner secret was issued", result.stdout)
        after = {path.name: path.read_text() for path in self.state.iterdir() if path.name != ".keys"}
        self.assertEqual(after, {name: text for name, text in before.items() if name != ".keys"})
        self.assertEqual(self.default_owner_key.read_text(encoding="utf-8"), owner_key)
        self.assertEqual([path.name for path in self.default_owner_key.parent.iterdir()],
                         [self.default_owner_key.name])

    def test_an_existing_owner_key_file_is_never_replaced(self):
        target = self.directory / "vault" / "owner.hex"
        target.parent.mkdir()
        target.write_text("an earlier owner key\n", encoding="utf-8")
        result = self.run_script("--apply", CLUSTER, "--owner-key-file", target.as_posix())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(target.read_text(encoding="utf-8"), "an earlier owner key\n")
        self.assertIn("already exists", result.stderr)
        (new_key,) = [path for path in target.parent.iterdir() if path != target]
        self.assertTrue(new_key.name.startswith("owner.hex."), new_key.name)
        _, owner_pub = self.owner_secret(new_key)
        self.assertIn(new_key.name, result.stdout)
        self.assertEqual(self.stored("owner-pubkey").read_text(encoding="utf-8").split()[1], owner_pub)

    def test_an_owner_key_path_inside_the_checkout_is_refused_before_any_write(self):
        stray = REPO_ROOT / "owner-key-must-not-exist"
        for target in (REPO_ROOT / "owner.hex", stray / "nested" / "owner.hex"):
            result = self.run_script("--apply", CLUSTER, "--owner-key-file", target.as_posix())
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertIn("inside this checkout", result.stderr)
            self.assertEqual(list(self.state.iterdir()), [])
            self.assertFalse(target.exists())
        self.assertFalse(stray.exists())

    def test_an_unusable_owner_key_location_is_refused_before_any_write(self):
        blocker = self.directory / "blocker"
        blocker.write_text("a file, not a directory", encoding="utf-8")
        for target in (blocker / "owner.hex", self.directory / "state"):
            result = self.run_script("--apply", CLUSTER, "--owner-key-file", target.as_posix())
            self.assertEqual(result.returncode, 2, result.stdout)
            self.assertEqual(list(self.state.iterdir()), [])
        if os.name == "posix":  # Git Bash restores an empty HOME on its own
            result = self.run_script("--apply", CLUSTER, HOME="")
            self.assertEqual(result.returncode, 2)
            self.assertIn("--owner-key-file", result.stderr)
            self.assertEqual(list(self.state.iterdir()), [])

    def test_bridge_scope_never_touches_the_owner_key_location(self):
        result = self.run_script("--apply", CLUSTER, "--scope", "bridge", HOME="")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(self.default_owner_key.parent.exists())

    def test_a_failed_write_is_an_error_not_an_existing_parameter(self):
        result = self.run_script(
            "--apply", CLUSTER, "--scope", "relay",
            STUB_PUT_ERROR="An error occurred (AccessDeniedException) when calling PutParameter",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("AccessDeniedException", result.stderr)
        self.assertNotIn("exists", result.stdout)
        self.assertFalse(self.default_owner_key.exists())

    def test_a_failed_owner_pubkey_write_leaves_no_secret_behind(self):
        result = self.run_script(
            "--apply", CLUSTER, "--scope", "relay",
            STUB_PUT_ERROR="An error occurred (AccessDeniedException) when calling PutParameter",
            STUB_PUT_ERROR_TAIL="/owner-pubkey",
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("AccessDeniedException", result.stderr)
        self.assertEqual(list(self.default_owner_key.parent.iterdir()), [])
        self.assertEqual(list(self.tmp.iterdir()), [])

    def test_value_files_are_handed_to_aws_as_native_paths(self):
        native_bin = self.directory / "native-bin"
        native_bin.mkdir()
        stub = native_bin / "cygpath"
        stub.write_text(CYGPATH_STUB, encoding="utf-8", newline="\n")
        stub.chmod(0o755)
        native = {"STUB_NATIVE_ROOT": self.tmp.as_posix(), "STUB_NATIVE_PREFIX": "X:"}

        # aws.exe cannot read /tmp/...; without a path conversion every put fails.
        unconverted = self.run_script("--apply", CLUSTER, "--scope", "relay", **native)
        self.assertEqual(unconverted.returncode, 1)
        self.assertIn("Unable to load paramfile", unconverted.stderr)

        path = f"{native_bin}{os.pathsep}{self.env['PATH']}"
        result = self.run_script("--apply", CLUSTER, PATH=path, **native)
        self.assertEqual(result.returncode, 0, result.stderr)
        for tail in ("relay-private-key", "git-hook-hmac", "redis-password", "agent-key-aria", "aria-db-password"):
            self.assertTrue(self.stored(tail).exists(), tail)
        self.assertEqual(list(self.tmp.iterdir()), [])

        plan = self.run_script("--plan", CLUSTER, "--scope", "relay", PATH=path, **native)
        self.assertEqual(plan.returncode, 0, plan.stderr)
        self.assertIn(f"--value file://X:{self.tmp.as_posix()}/git-hook-hmac.val", plan.stdout)
        self.assertNotIn("/dev/shm", plan.stdout)

    def test_plan_reads_the_private_record(self):
        result = self.run_script("--plan", CLUSTER, "--scope", "relay")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"account {ACCOUNT}, prefix {PREFIX})", result.stdout)
        self.assertIn(f"--name {PREFIX}/relay-private-key", result.stdout)
        self.assertIn(self.default_owner_key.name, result.stdout)
        self.assertFalse(self.default_owner_key.parent.exists())

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
