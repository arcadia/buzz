#!/usr/bin/env python3
"""Exercise the workflow's real planning command without AWS or GitHub I/O."""

import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

SCRIPT = Path(__file__).with_name("ecr-release-plan.py")
CHART = SCRIPT.parents[1] / "charts/buzz-arcadia"
EXAMPLE_SUFFIX = "-values.example.yaml"
ENVIRONMENTS = [path.name[: -len(EXAMPLE_SUFFIX)] for path in sorted((CHART / "ci").glob("*" + EXAMPLE_SUFFIX))]
# Synthetic account ids, one repeated digit per environment, as the repository secrets would supply them.
ACCOUNTS = {
    "AWS_ACCOUNT_ID_" + name.replace("-", "_").upper(): str(index) * 12
    for index, name in enumerate(ENVIRONMENTS, start=1)
}
ROLES = {
    "ECR_ROLE_ARN_" + name.replace("-", "_").upper(): f"arn:aws:iam::{str(index) * 12}:role/buzz-ecr"
    for index, name in enumerate(ENVIRONMENTS, start=1)
}
FIRST_ACCOUNT, SECOND_ACCOUNT = sorted(ACCOUNTS)[:2]
FIRST_ROLE, SECOND_ROLE = sorted(ROLES)[:2]
CONFIG = {
    "GITHUB_EVENT_NAME": "workflow_dispatch",
    "GITHUB_REF": "refs/heads/main",
    "GITHUB_SHA": "1" * 40,
    **ACCOUNTS,
    **ROLES,
}


def execute(settings):
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "output"
        summary = Path(directory) / "summary"
        env = {key: value for key, value in os.environ.items() if not key.startswith(
            ("GITHUB_", "BUZZ_", "ECR_ROLE_", "AWS_ACCOUNT_ID_", "RELEASE_MODE", "DEPLOY_DEV", "GITOPS_")
        )}
        result = subprocess.run(
            [sys.executable, str(SCRIPT)], text=True, capture_output=True, timeout=10,
            env={**env, **settings, "GITHUB_OUTPUT": str(output), "GITHUB_STEP_SUMMARY": str(summary)},
        )
        return result, output.read_text() if output.exists() else "", summary.read_text() if summary.exists() else ""


def parse(output):
    return dict(line.split("=", 1) for line in output.splitlines())


class ReleasePlanTests(unittest.TestCase):
    def test_unconfigured_main_and_pr_never_request_credentials_or_claim_publication(self):
        for event in ("push", "pull_request"):
            result, output, summary = execute({"GITHUB_EVENT_NAME": event})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(output, "run=false\npublish=false\ndeploy_dev=false\n")
            self.assertIn("no publication attempted", summary)

    def test_manual_defaults_to_read_only_preflight(self):
        result, output, summary = execute(CONFIG)
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = parse(output)
        self.assertEqual(
            (outputs["run"], outputs["publish"], outputs["deploy_dev"]), ("true", "false", "false"),
        )
        self.assertIn("no image publication or GitOps write", summary)

    def test_region_and_repository_come_from_the_chart_and_no_account_leaves_the_job(self):
        result, output, summary = execute(CONFIG)
        self.assertEqual(result.returncode, 0, result.stderr)
        outputs = parse(output)
        chart = yaml.safe_load((CHART / "values.yaml").read_text(encoding="utf-8"))
        self.assertEqual(outputs["region"], chart["region"])
        self.assertEqual(outputs["repository"], chart["relayImage"]["repositoryPath"])
        for account in ACCOUNTS.values():
            for text in (output, summary, result.stdout, result.stderr):
                self.assertNotIn(account, text)

    def test_publish_requires_explicit_request_and_separate_dev_opt_in(self):
        for settings in (
            {"RELEASE_MODE": "publish"},
            {"GITHUB_EVENT_NAME": "push", "BUZZ_ECR_PUBLISH_ENABLED": "true"},
        ):
            result, output, _ = execute({**CONFIG, **settings})
            self.assertEqual(result.returncode, 0, result.stderr)
            outputs = parse(output)
            self.assertEqual(
                (outputs["run"], outputs["publish"], outputs["deploy_dev"]), ("true", "true", "false"),
            )
        result, output, _ = execute({
            **CONFIG, "RELEASE_MODE": "publish", "DEPLOY_DEV": "true",
            "GITOPS_CREDENTIALS_CONFIGURED": "true",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(parse(output)["deploy_dev"], "true")

    def test_invalid_requests_fail_without_outputs(self):
        for settings in (
            {FIRST_ROLE: ""},
            {SECOND_ROLE: CONFIG[FIRST_ROLE]},
            {FIRST_ACCOUNT: ""},
            {FIRST_ACCOUNT: "12345"},
            {SECOND_ACCOUNT: CONFIG[FIRST_ACCOUNT], SECOND_ROLE: CONFIG[FIRST_ROLE]},
            {"GITHUB_REF": "refs/heads/feature"},
            {"GITHUB_SHA": "main"},
            {"RELEASE_MODE": "unknown"},
            {"DEPLOY_DEV": "true"},
            {"RELEASE_MODE": "publish", "DEPLOY_DEV": "true"},
            {"GITHUB_EVENT_NAME": "push", "BUZZ_ECR_PUBLISH_ENABLED": "true", SECOND_ROLE: ""},
        ):
            with self.subTest(settings=settings):
                result, output, summary = execute({**CONFIG, **settings})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("::error::", result.stderr)
                self.assertEqual(output, "")
                self.assertEqual(summary, "")
                for account in ACCOUNTS.values():
                    self.assertNotIn(account, result.stderr)


if __name__ == "__main__":
    unittest.main()
