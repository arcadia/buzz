#!/usr/bin/env python3
"""Validate release intent before requesting AWS credentials or publishing.

Account ids and role ARNs are never read from this public repository: they
arrive as repository secrets (AWS_ACCOUNT_ID_<CLUSTER>, ECR_ROLE_ARN_<CLUSTER>),
so GitHub masks them in the public run logs. They are not written to job
outputs either, because GitHub drops any output that contains a secret.
"""

import os
from pathlib import Path
import re
import sys

import yaml

CHART = Path(__file__).resolve().parents[1] / "charts/buzz-arcadia"
EXAMPLE_SUFFIX = "-values.example.yaml"


def output_key(environment):
    return environment.replace("-", "_")


def role_variable(environment):
    return "ECR_ROLE_ARN_" + output_key(environment).upper()


def account_variable(environment):
    return "AWS_ACCOUNT_ID_" + output_key(environment).upper()


def environments(chart=CHART):
    """Cluster names, from the chart's ci/<clusterName>-values.example.yaml fixtures."""
    names = [path.name[: -len(EXAMPLE_SUFFIX)] for path in sorted((chart / "ci").glob("*" + EXAMPLE_SUFFIX))]
    if not names:
        raise ValueError(f"No environment fixtures under {chart / 'ci'}.")
    return names


def chart_defaults(chart=CHART):
    values = yaml.safe_load((chart / "values.yaml").read_text(encoding="utf-8"))
    repository = (values.get("relayImage") or {}).get("repositoryPath", "")
    if not re.fullmatch(r"[a-z0-9]+(?:[._/-][a-z0-9]+)*", repository):
        raise ValueError("values.yaml relayImage.repositoryPath must be an ECR repository name.")
    region = str(values.get("region", ""))
    if not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-[0-9]", region):
        raise ValueError("values.yaml region must be an AWS region.")
    return region, repository


def plan(env):
    outputs = {"run": False, "publish": False, "deploy_dev": False}
    event = env.get("GITHUB_EVENT_NAME", "")
    if event == "pull_request":
        return outputs, "Pull request validation only; no publication attempted."
    automatic = event == "push"
    if automatic and env.get("BUZZ_ECR_PUBLISH_ENABLED", "") != "true":
        return outputs, "Automatic ECR publication is disabled; no publication attempted."
    if not automatic and event != "workflow_dispatch":
        raise ValueError("Unsupported release event.")
    if env.get("GITHUB_REF") != "refs/heads/main":
        raise ValueError("ECR releases must use the main branch.")
    if not re.fullmatch(r"[0-9a-f]{40}", env.get("GITHUB_SHA", "")):
        raise ValueError("A full source commit SHA is required.")
    mode = "publish" if automatic else env.get("RELEASE_MODE", "preflight")
    if mode not in {"preflight", "publish"}:
        raise ValueError("Release mode must be preflight or publish.")
    accounts = set()
    for name in environments():
        account = env.get(account_variable(name), "")
        if not re.fullmatch(r"[0-9]{12}", account):
            raise ValueError(f"{account_variable(name)} must be the {name} AWS account id; set the secret first.")
        if account in accounts:
            raise ValueError(f"{account_variable(name)} repeats another environment's account.")
        accounts.add(account)
        key = role_variable(name)
        if not re.fullmatch(rf"arn:aws:iam::{account}:role/[\w+=,.@/-]+", env.get(key, "")):
            raise ValueError(f"{key} must identify a role in the {name} account; provision it first.")
    deploy = (
        env.get("BUZZ_DEV_GITOPS_ENABLED") == "true"
        if automatic else env.get("DEPLOY_DEV") == "true"
    )
    if deploy and mode != "publish":
        raise ValueError("Dev GitOps requires publish mode.")
    if deploy and env.get("GITOPS_CREDENTIALS_CONFIGURED") != "true":
        raise ValueError("Dev GitOps was requested but repository-manager credentials are missing.")
    message = (
        "Publication requested; every account preflight must pass before image push."
        if mode == "publish" else
        "Read-only AWS preflight requested; no image publication or GitOps write will occur."
    )
    region, repository = chart_defaults()
    outputs.update(run=True, publish=mode == "publish", deploy_dev=deploy, region=region, repository=repository)
    return outputs, message


def main():
    try:
        outputs, message = plan(os.environ)
    except ValueError as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    lines = "".join(
        f"{key}={str(value).lower() if isinstance(value, bool) else value}\n"
        for key, value in outputs.items()
    )
    if path := os.environ.get("GITHUB_OUTPUT"):
        with Path(path).open("a", encoding="utf-8") as file:
            file.write(lines)
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with Path(path).open("a", encoding="utf-8") as file:
            file.write(message + "\n")
    print(message)
    return 0


if __name__ == "__main__":
    sys.exit(main())
