#!/usr/bin/env python3
"""Render both Arcadia environments and verify the offline package/security contract.

The committed environment files are dummies. Set BUZZ_ENV_DIR to a cluster's
directory in a cloud-config-infrastructures checkout (e.g. preprd/dev-ai) to
also render that real environment through deploy/scripts/env-values.py.
"""

import ipaddress
from pathlib import Path
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[2]
CHART = ROOT / "deploy/charts/buzz-arcadia"
UPSTREAM = ROOT / "deploy/charts/buzz"
ENV_VALUES = ROOT / "deploy/scripts/env-values.py"
TEST_OWNER = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
# The aria-buzz-bridge chart derives the relay's RDS connection Secret as
# <namespace>-<clusterName>-<database.claimName>-connection with this default.
BRIDGE_DEFAULT_CLAIM = "buzz"
EXAMPLE_SUFFIX = "-values.example.yaml"
EXAMPLES = {
    path.name[: -len(EXAMPLE_SUFFIX)]: path
    for path in sorted((CHART / "ci").glob("*" + EXAMPLE_SUFFIX))
}
GLOBALS = ("account", "region", "clusterName", "infrastructure", "domainCertArn", "domainHostedZone")
# What this repository adds for the Arcadia deployment; none of it may carry a real identifier.
ARCADIA_PATHS = (
    ".github/workflows/build-and-push-ecr.yml",
    "deploy/BOOTSTRAP.md",
    "deploy/scripts",
    "deploy/charts/buzz-arcadia",
)
DOCUMENTATION_NETWORKS = [
    ipaddress.ip_network(cidr) for cidr in ("192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24")
]


def load(path):
    return yaml.safe_load(Path(path).read_text(encoding="utf-8"))


def write_cluster_directory(record, directory):
    """Lay a flat environment record out as a cloud-config-infrastructures cluster directory."""
    directory = Path(directory)
    (directory / "buzz").mkdir(parents=True)
    patch = {
        "apiVersion": "argoproj.io/v1alpha1",
        "kind": "Application",
        "metadata": {"name": "ignored"},
        "spec": {"source": {"helm": {"parameters": [
            {"name": key, "value": str(record[key])} for key in GLOBALS
        ] + [{"name": "argocdNamespace", "value": "argocd"}]}}},
    }
    (directory / "global-helm-values-patch.yaml").write_text(yaml.safe_dump(patch), encoding="utf-8")
    values = {key: value for key, value in record.items() if key not in GLOBALS}
    (directory / "buzz/values.yaml").write_text(yaml.safe_dump(values), encoding="utf-8")
    return directory


def committable_files():
    """Tracked and not-ignored files under ARCADIA_PATHS: what a commit would publish."""
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", *ARCADIA_PATHS],
        cwd=ROOT, capture_output=True, timeout=30, check=True,
    ).stdout.decode("utf-8").split("\0")
    return sorted(
        path for path in (ROOT / name for name in listed if name)
        if path.is_file() and path.suffix != ".tgz"
    )


def compose(directory):
    return subprocess.run(
        [sys.executable, str(ENV_VALUES), str(directory)],
        text=True, capture_output=True, timeout=30, check=False,
    )


def render(values_file, overrides=(), *, fixtures=True):
    command = [
        "helm", "template", "buzz", str(CHART), "--namespace", "buzz",
        "-f", str(values_file),
    ]
    overridden = {value.split("=", 1)[0] for value in overrides}
    if fixtures:
        for value in (
            f"buzz.ownerPubkey={TEST_OWNER}",
            "buzz.image.tag=main-1111111111",
            "rds.jiraTicketNumber=FIXTURE-1",
        ):
            if value.split("=", 1)[0] not in overridden:
                command.extend(["--set-string", value])
    for value in overrides:
        key = value.split("=", 1)[0]
        option = "--set-string" if key in {
            "buzz.ownerPubkey", "buzz.image.tag", "rds.jiraTicketNumber",
        } else "--set"
        command.extend([option, value])
    # Helm template must consume the committed package, never a public registry.
    return subprocess.run(
        command,
        env={**os.environ, "HTTPS_PROXY": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1"},
        text=True, capture_output=True, timeout=30, check=False,
    )


class ArcadiaChartTests(unittest.TestCase):
    def test_packaged_upstream_is_current_and_contains_locked_dependencies(self):
        upstream = yaml.safe_load((UPSTREAM / "Chart.yaml").read_text())
        wrapper = yaml.safe_load((CHART / "Chart.yaml").read_text())
        self.assertEqual(wrapper["dependencies"][0]["version"], upstream["version"])
        package = CHART / f"charts/buzz-{upstream['version']}.tgz"
        with tarfile.open(package) as archive:
            for source in UPSTREAM.rglob("*"):
                relative = source.relative_to(UPSTREAM)
                if not source.is_file() or "charts" in relative.parts or any(
                    part.startswith(".") for part in relative.parts
                ):
                    continue
                packaged = archive.extractfile(f"buzz/{relative.as_posix()}").read()
                if relative.name in ("Chart.yaml", "Chart.lock"):
                    actual = yaml.safe_load(packaged)
                    expected = yaml.safe_load(source.read_bytes())
                    # Helm's packager folds the multiline chart description.
                    if relative.name == "Chart.yaml":
                        for metadata in (actual, expected):
                            metadata["description"] = " ".join(metadata["description"].split())
                    self.assertEqual(actual, expected)
                else:
                    self.assertEqual(packaged, source.read_bytes(), str(relative))
            lock = yaml.safe_load((UPSTREAM / "Chart.lock").read_text())
            for dependency in lock["dependencies"]:
                metadata = yaml.safe_load(archive.extractfile(
                    f"buzz/charts/{dependency['name']}/Chart.yaml"
                ).read())
                self.assertEqual(metadata["version"], dependency["version"])
                self.assertIn(
                    f"buzz/charts/{dependency['name']}/charts/common/Chart.yaml",
                    archive.getnames(),
                )

    def environments(self):
        found = dict(EXAMPLES)
        private = os.environ.get("BUZZ_ENV_DIR")
        if private:
            composed = compose(private)
            self.assertEqual(composed.returncode, 0, composed.stderr)
            directory = Path(tempfile.mkdtemp())
            self.addCleanup(shutil.rmtree, directory, ignore_errors=True)
            path = directory / "private-values.yaml"
            path.write_text(composed.stdout, encoding="utf-8")
            found[f"{load(path)['clusterName']} (BUZZ_ENV_DIR)"] = path
        return found

    def test_every_environment_renders_offline_with_isolated_secrets_and_private_network(self):
        self.assertGreaterEqual(len(EXAMPLES), 2, EXAMPLES)
        for name, values_file in self.environments().items():
            with self.subTest(environment=name):
                config = load(values_file)
                account, region = config["account"], config["region"]
                environment = config["clusterName"]
                if name in EXAMPLES:
                    self.assertEqual(environment, name)
                result = render(values_file)
                self.assertEqual(result.returncode, 0, result.stderr)
                objects = {
                    (item["kind"], item["metadata"]["name"]): item
                    for item in yaml.safe_load_all(result.stdout) if item
                }
                relay = objects[("Deployment", "buzz")]
                container = relay["spec"]["template"]["spec"]["containers"][0]
                self.assertEqual(
                    container["image"],
                    f"{account}.dkr.ecr.{region}.amazonaws.com/buzz/relay:main-1111111111",
                )
                env = {item["name"]: item for item in container["env"]}
                for name, value in {
                    "BUZZ_REQUIRE_AUTH_TOKEN": "true",
                    "BUZZ_REQUIRE_RELAY_MEMBERSHIP": "true",
                    "BUZZ_AUDIT_ENABLED": "true",
                    "BUZZ_EPHEMERAL_TTL_OVERRIDE": "604800",
                    "BUZZ_GIT_CONFORMANCE_PROBE": "false",
                }.items():
                    self.assertEqual(env[name]["value"], value)
                self.assertNotIn("BUZZ_MEDIA_UPLOAD_RECORDS", env)
                self.assertNotIn("BUZZ_REQUIRE_MEDIA_GET_AUTH", env)
                for name in ("BUZZ_RELAY_PRIVATE_KEY", "DATABASE_URL", "REDIS_URL"):
                    self.assertEqual(env[name]["valueFrom"]["secretKeyRef"]["name"], "buzz-secrets")
                self.assertNotIn("Secret", {kind for kind, _ in objects})
                ingress = objects[("Ingress", "buzz")]["metadata"]["annotations"]
                self.assertEqual(ingress["alb.ingress.kubernetes.io/scheme"], "internal")
                self.assertIn(f":{account}:", ingress["alb.ingress.kubernetes.io/certificate-arn"])
                rds = objects[("RDS", f"{environment}-{BRIDGE_DEFAULT_CLAIM}")]["spec"]
                self.assertTrue(rds["storageEncrypted"])
                self.assertFalse(rds["publiclyAccessible"])
                self.assertTrue(rds["deletionProtection"])
                self.assertFalse(rds["skipFinalSnapshot"])
                self.assertEqual(rds["deletionPolicy"], "Orphan")
                connection = f"buzz-{environment}-{BRIDGE_DEFAULT_CLAIM}-connection"
                self.assertEqual(rds["writeConnectionSecretToRef"]["name"], connection)
                relay_policy = objects[("NetworkPolicy", "buzz-relay")]["spec"]
                self.assertEqual(
                    [peer["ipBlock"]["cidr"] for peer in relay_policy["ingress"][0]["from"]],
                    config["rds"]["cidrBlocks"],
                )
                self.assertIn(("NetworkPolicy", "buzz-redis"), objects)
                self.assertIn(("ExternalSecret", "buzz-secrets"), objects)
                role = objects[("Role", "buzz-crossplane-reader")]["rules"][0]
                self.assertEqual(role["resourceNames"], [connection])
                store = objects[("SecretStore", "buzz-crossplane-connection")]["spec"]["provider"]["kubernetes"]
                # ESO rejects either namespace field on a namespaced SecretStore.
                self.assertNotIn("namespace", store["server"]["caProvider"])
                self.assertNotIn("namespace", store["auth"]["serviceAccount"])

    def test_invalid_deployment_inputs_fail_before_apply(self):
        cases = [
            ("account=", "account is required"),
            ("buzz.image.repository=ghcr.io/block/buzz", "buzz.image.repository must be"),
            ("buzz.image.tag=main-0000000000", "placeholder cannot be deployed"),
            ("buzz.ownerPubkey=" + "0" * 64, "placeholder cannot be deployed"),
            ("rds.jiraTicketNumber=", "rds.jiraTicketNumber is required"),
            ("buzz.secrets.existingSecret=wrong-secret", "must equal externalSecret.targetName"),
            ("ingress.host=wrong.example", "must equal the authority"),
            ("buzz.postgresql.enabled=true", "must stay false"),
            ("buzz.redis.enabled=true", "must stay false"),
            ("buzz.s3.endpoint=https://unexpected.example", "S3/media is out of phase 0"),
            ("networkPolicy.allowedIngressCidrs={10.0.0.0/8}", "must not contain 10.0.0.0/8"),
        ]
        example = next(iter(EXAMPLES.values()))
        for override, message in cases:
            with self.subTest(override=override):
                result = render(example, [override])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
        self.assertNotEqual(render(example, fixtures=False).returncode, 0)

    def test_a_private_cluster_directory_composes_to_the_same_record(self):
        for name, path in EXAMPLES.items():
            with self.subTest(environment=name), tempfile.TemporaryDirectory() as directory:
                record = load(path)
                cluster = write_cluster_directory(record, Path(directory) / name)
                composed = compose(cluster)
                self.assertEqual(composed.returncode, 0, composed.stderr)
                self.assertEqual(yaml.safe_load(composed.stdout), record)
                values = load(cluster / "buzz/values.yaml")
                (cluster / "buzz/values.yaml").write_text(
                    yaml.safe_dump({**values, "account": record["account"]}), encoding="utf-8",
                )
                repeated = compose(cluster)
                self.assertEqual(repeated.returncode, 2)
                self.assertIn("repeats the cluster globals account", repeated.stderr)

    def test_the_public_files_carry_only_dummy_identifiers(self):
        for path in EXAMPLES.values():
            for cidr in load(path)["rds"]["cidrBlocks"]:
                network = ipaddress.ip_network(cidr)
                self.assertTrue(
                    any(network.subnet_of(allowed) for allowed in DOCUMENTATION_NETWORKS),
                    f"{path.name}: {cidr} is not an RFC 5737 documentation range",
                )
        # label -> (what a real identifier looks like, what the allowed dummies look like)
        patterns = {
            "AWS account id": (r"(?<![0-9])[0-9]{12}(?![0-9])", r"([0-9])\1{11}|123456789012"),
            "subnet id": (r"\bsubnet-[0-9a-f]{8,17}\b", r"subnet-0+[1-9]"),
            "VPC or security group id": (r"\b(?:vpc|sg)-[0-9a-f]{8,17}\b", r"(?!)"),
            "ACM certificate id": (r"certificate/[0-9a-f-]{36}", r"certificate/[0-]{36}"),
            "EKS endpoint": (r"[0-9A-Fa-f]{32}\.[a-z0-9]+\.[a-z0-9-]+\.eks\.amazonaws\.com", r"(?!)"),
            "EKS OIDC provider id": (r"(?<![0-9A-Za-z])[0-9A-F]{32}(?![0-9A-Za-z])", r"0{32}"),
        }
        files = committable_files()
        self.assertLessEqual(set(EXAMPLES.values()), set(files))
        for path in files:
            text = path.read_text(encoding="utf-8", errors="replace")
            for label, (pattern, dummy) in patterns.items():
                for match in re.finditer(pattern, text):
                    self.assertRegex(
                        match.group(0), rf"^(?:{dummy})$",
                        f"{path.relative_to(ROOT)} contains a real-looking {label}; "
                        "real identifiers belong in cloud-config-infrastructures",
                    )


if __name__ == "__main__":
    unittest.main()
