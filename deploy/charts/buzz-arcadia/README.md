# buzz-arcadia

Arcadia deployment wrapper around the vendored upstream `buzz` relay chart
(`../buzz`, v0.1.6). Deployed by Argo CD from `cloud-config-infrastructures`:

| | dev-ai | prd-ai |
|---|---|---|
| CCI branch / path | `ai-dev` · `preprd/dev-ai/buzz/application.yaml` | `ai` · `prd/ai/buzz/application.yaml` |
| namespace / sync-wave | `buzz` / 70 | `buzz` / 70 |
| host | `buzz.ai-dev.arcadiaanalytics.com` | `buzz.ai.arcadiaanalytics.com` |
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

1. **Parent level** — Arcadia wiring plus the nine cluster globals that
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

## Parent-level values the Argo CD Application must carry

Everything else has a working default in `values.yaml`; the per-environment
fixtures in `ci/` are the copyable reference.

| Key | dev-ai | prd-ai |
|---|---|---|
| `buzz.relayUrl` | `wss://buzz.ai-dev.arcadiaanalytics.com` | `wss://buzz.ai.arcadiaanalytics.com` |
| `buzz.ownerPubkey` | 64-char hex, from `buzz-admin generate-key` | ditto (different key) |
| `buzz.image.repository` | `258174056699.dkr.ecr.us-east-1.amazonaws.com/buzz/relay` | `572630832277.dkr.ecr.us-east-1.amazonaws.com/buzz/relay` |
| `buzz.image.tag` | `main-<short10-sha>` (CI-bumped) | pinned by hand |
| `buzz.replicaCount` | `1` | `2` |
| `rds.dbInstanceClass` / `rds.multiAZ` | `db.m6g.large` / `false` | `db.r6g.large` / `true` |
| `rds.subnetIds` | `subnet-030ae42f02e760072`, `subnet-0fb83eab49c6b90d2`, `subnet-0d451196beeeaeb5a` | `subnet-037cfc7c119bdcff2`, `subnet-09c641cd86e3c7e32`, `subnet-081b52b0e4afb2f54` |
| `rds.cidrBlocks` / `networkPolicy.allowedIngressCidrs` | `10.54.0.0/17`, `10.54.128.0/17` | `10.52.0.0/17`, `10.52.128.0/17` |
| `rds.jiraTicketNumber` | AIFM ticket for the rollout | AIFM ticket + ACM CR |

## SSM parameters this chart reads

Path is `/<infrastructure>/<clusterName>/<tail>` — i.e. `/ai-dev/dev-ai/buzz/*`
on dev-ai and `/ai/prd-ai/buzz/*` on prd-ai. All must exist **before** the
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
helm dependency build deploy/charts/buzz-arcadia
helm lint     deploy/charts/buzz-arcadia -f deploy/charts/buzz-arcadia/ci/dev-ai-values.yaml
helm template buzz deploy/charts/buzz-arcadia -n buzz \
  -f deploy/charts/buzz-arcadia/ci/dev-ai-values.yaml
```

The fixtures include the nine globals so the chart renders standalone; in the
cluster they arrive as parent-level `--set` parameters from the Kustomize patch
and must **not** be repeated in the Application's `helm.values`.

## First sync

The RDS instance does not exist yet, so the ExternalSecret reports
`SecretSyncedError` and the relay Pods crash-loop until Crossplane finishes
provisioning. That is expected and self-healing — do not add `helm --wait`
semantics or a blocking sync-wave around the claim.
