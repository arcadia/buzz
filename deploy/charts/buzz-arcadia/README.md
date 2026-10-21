# buzz-arcadia

Arcadia deployment wrapper around the vendored upstream `buzz` relay chart
(`../buzz`, v0.1.11). This is a deployment candidate, not evidence of a live
deployment. The previous deployment and CCI PRs were closed unmerged. The
intended Argo CD Applications in `cloud-config-infrastructures` are:

| | dev-ai | prd-ai |
|---|---|---|
| CCI branch / path | `ai-dev` · `preprd/dev-ai/buzz/application.yaml` | `ai` · `prd/ai/buzz/application.yaml` |
| namespace / sync-wave | `buzz` / 70 | `buzz` / 70 |
| host, account, network (private) | `preprd/dev-ai/global-helm-values-patch.yaml` + `preprd/dev-ai/buzz/values.yaml` | `prd/ai/global-helm-values-patch.yaml` + `prd/ai/buzz/values.yaml` |
| image tag | bumped by the fork's `deploy-dev` CI job | pinned by hand (ACM CR gated) |

The bridge (`aria-frontend/deploy/k8s/aria-buzz-bridge`) is a **separate**
Application at wave 71 with its own ExternalSecret — relay Pods never mount
agent private keys and vice versa.

## What this chart adds on top of the vendored chart

| Template | Why the upstream chart cannot do it |
|---|---|
| `externalsecret.yaml` | ESO → `ClusterSecretStore/ssm-clustersecretstore`, producing the single Secret named in `buzz.secrets.existingSecret`. Mandatory under Argo: the subchart's own Secret path uses `lookup` + `randAlphaNum` and would regenerate the relay identity on every sync. |
| `database-url.yaml` | Crossplane emits `username`/`password`/`endpoint`, never a URL, and the endpoint does not exist before the first sync — so `DATABASE_URL` cannot be an SSM parameter. A namespaced ESO SecretStore (Kubernetes provider, scoped to the one connection Secret) feeds the composition in `externalsecret.yaml`. |
| `rds-claim.yaml` | Crossplane `RDS` claim, full required schema, non-burstable class per environment. |
| `redis.yaml` | Single in-cluster Redis on the ECR-mirrored Chainguard image; `REDIS_URL` composed from this Service + the SSM password. |
| `networkpolicy.yaml` | Ingress scoped to the environment's real VPC CIDRs; Redis reachable from relay Pods only. |
| `ingress.yaml` | Internal ALB with `idle_timeout.timeout_seconds=3600`, built from the injected `domainCertArn` / `domainHostedZone` globals. The subchart's own ingress stays disabled. |

## Value tiers

Two, and they are not interchangeable:

1. **Parent level** — Arcadia wiring plus the cluster globals that
   `global-helm-values-patch.yaml` appends to every Application as
   `spec.source.helm.parameters`.
2. **`buzz:` subtree** — the vendored chart. Helm passes *only* `.Values.buzz`
   to the subchart, so a relay value written flat at the parent level is
   silently ignored and the subchart hard-fails with `relayUrl is required`.

Helm cannot copy a parent value into a subchart's subtree (parent `values.yaml`
is plain YAML, and subchart templates render before parent templates, so a
parent template cannot mutate them either). Consequences:

- The Application supplies `buzz.image.repository` in full; the wrapper
  **enforces** that it equals
  `<account>.dkr.ecr.<region>.amazonaws.com/buzz/relay` and fails the render
  otherwise (`relayImage.enforceComposedRepository`).
- There is no `image.registry` key to set — the vendored `values.schema.json`
  declares `image.additionalProperties: false`, so any extra key fails
  validation.

## Environment records

This repository is public, so it records no real environment identifiers.
Each environment's record is private, in `cloud-config-infrastructures` on the
cluster's branch (table above):

- `<cluster dir>/global-helm-values-patch.yaml`: the cluster globals (account,
  region, clusterName, infrastructure, domainCertArn, domainHostedZone) that
  every Application receives as parent-level `spec.source.helm.parameters`.
- `<cluster dir>/buzz/values.yaml`: this chart's values for the environment
  (relay URL, image repository, subnets, CIDRs, RDS class, replicas). It must
  not repeat a global.

`ci/<clusterName>-values.example.yaml` has the same shape with dummy values,
and the tests render it. `deploy/scripts/env-values.py <cluster dir>` composes
the two private files into one render-ready values file, and
`provision-secrets.sh --env-dir <cluster dir>` reads the globals from the same
place. The ECR workflow takes account ids and role ARNs from repository
secrets (see its header). This README and the runbooks do not restate any of
those identifiers.

## Values the Argo CD Application must carry

The private values carry a zero owner key/image tag and an empty rollout
ticket, which the chart deliberately rejects: replace them with the reviewed
operator identity, an existing published image, and the rollout ticket before
creating an Application.

| Key | Source |
|---|---|
| `buzz.relayUrl`, `buzz.image.repository`, `rds.subnetIds`, `rds.cidrBlocks` (= `networkPolicy.allowedIngressCidrs`), `rds.dbInstanceClass`, `rds.multiAZ`, `buzz.replicaCount` | `<cluster dir>/buzz/values.yaml`, as is |
| `buzz.ownerPubkey` | 64-char hex from `buzz-admin generate-key`, one per environment |
| `buzz.image.tag` | `main-<short10-sha>`: CI-bumped on dev-ai, pinned by hand on prd-ai |
| `rds.jiraTicketNumber` | the AIFM rollout ticket (prd-ai: plus the ACM CR) |

`rds.claimName` stays `buzz`: the bridge chart derives the same Crossplane
connection Secret name (`<ns>-<clusterName>-buzz-connection`) from its own
default.

## SSM parameters this chart reads

Path is `/<infrastructure>/<clusterName>/<tail>`, with both segments from the
cluster's `global-helm-values-patch.yaml`. All must exist **before** the
Application syncs: one missing parameter fails the whole ExternalSecret, for
every Pod (pre-flight runbook: `PREFLIGHT.md`).

| Secret key | SSM tail |
|---|---|
| `BUZZ_RELAY_PRIVATE_KEY` | `buzz/relay-private-key` |
| `BUZZ_GIT_HOOK_HMAC_SECRET` | `buzz/git-hook-hmac` |
| `REDIS_PASSWORD` | `buzz/redis-password` |

Composed in-cluster, **not** in SSM: `DATABASE_URL` (from the Crossplane
connection Secret `<ns>-<clusterName>-<rds.claimName>-connection`, keys
`username`/`password`/`endpoint`) and `REDIS_URL` (Redis Service + the password
above). Deliberately absent: S3 credentials (no media in phase 0; IRSA when it
lands) and LiteLLM keys (fetched per enrolled human at runtime by the bridge).

## Rendering

```bash
# Networked maintainer/CI step, only when the upstream chart changes:
python3 deploy/scripts/package-arcadia-chart.py
# Offline render and failure-contract tests (requires Helm and PyYAML):
python3 deploy/scripts/test-arcadia-chart.py
```

Commit `charts/buzz-0.1.11.tgz` and `Chart.lock` together. The archive contains
the unchanged upstream chart and its locked postgres 0.19.5 / redis 0.30.3
dependencies, including their common library. Do not delete upstream
dependencies or run registry resolution in the private Argo repo-server.
Argo's normal `helm template` uses the committed package without internet
access. Tests compare the package with the sibling source, render both dummy
environment files with explicit synthetic, non-deployable test inputs, and
fail if a real-looking account, subnet, certificate or EKS identifier appears
in the files this repository adds for the deployment.

For a deployment candidate, compose the private record and render it with a
separate reviewed values file:

```bash
python deploy/scripts/env-values.py <cci>/preprd/dev-ai > /secure/path/dev-ai-values.yaml
helm template buzz deploy/charts/buzz-arcadia -n buzz \
  -f /secure/path/dev-ai-values.yaml \
  -f /secure/path/reviewed-buzz-values.yaml
# The same contract tests, against the real environment:
BUZZ_ENV_DIR=<cci>/preprd/dev-ai python deploy/scripts/test-arcadia-chart.py
```

The composed file includes the globals this chart reads so it renders
standalone; in the cluster they arrive as parent-level `--set` parameters from
the Kustomize patch and must **not** be repeated in the Application's
`helm.values`. Keep composed files outside this checkout (`ci/*-values.yaml`
is git-ignored as a backstop).

## First sync

The RDS instance does not exist yet, so the ExternalSecret reports
`SecretSyncedError` and the relay Pods crash-loop until Crossplane finishes
provisioning. That is expected and self-healing — do not add `helm --wait`
semantics or a blocking sync-wave around the claim.
