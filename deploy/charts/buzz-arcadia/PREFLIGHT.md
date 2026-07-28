# PREFLIGHT — before the buzz ArgoCD Application merges

Spec node **N6**. Everything on this page happens **out of band, before** the
`cloud-config-infrastructures` PR that creates the Application is merged. Nothing
here is created by the chart, by ArgoCD, or by Crossplane.

The one-line gate:

```bash
deploy/scripts/provision-secrets.sh --verify dev-ai   # must exit 0
```

## Why the ordering is not negotiable

External Secrets Operator resolves an `ExternalSecret` **all-or-nothing**. A
single missing SSM parameter leaves `buzz-secrets` unwritten, and every relay
Pod then crash-loops on a missing env var — with nothing in any log naming the
parameter that was absent. The failure mode is maximally expensive and minimally
informative, which is why the verify loop exists and why it runs before the
merge rather than after the sync.

## Environment map

`infrastructure` is **not** the cluster name — they are transposed, and getting
it backwards writes parameters into a path ESO will never read.

| | dev-ai | prd-ai |
|---|---|---|
| AWS account | `258174056699` | `572630832277` |
| `infrastructure` | `ai-dev` | `ai` |
| SSM prefix | `/ai-dev/dev-ai/buzz/` | `/ai/prd-ai/buzz/` |
| CCI branch / path | `ai-dev` · `preprd/dev-ai/buzz/` | `ai` · `prd/ai/buzz/` |
| public host | `buzz.ai-dev.arcadiaanalytics.com` | `buzz.ai.arcadiaanalytics.com` |
| gates before merge | AIFM ticket + peer review | AIFM + **approved ACM CR**, deployer ≠ implementer |

`provision-secrets.sh` refuses to run when the caller's AWS account does not
match the cluster argument.

## The parameters

Path is `/<infrastructure>/<clusterName>/buzz/<tail>`. The **relay** tier is
consumed by this chart's `ExternalSecret` → Secret `buzz-secrets`. The **bridge**
tier is consumed by `aria-frontend/deploy/k8s/aria-buzz-bridge`'s own
`ExternalSecret` → Secret `buzz-bridge-secrets` (decision D12: relay Pods never
mount agent private keys, and the bridge never mounts the relay identity).

| Tail | Type | Tier | Produced by | Consumed as |
|---|---|---|---|---|
| `relay-private-key` | SecureString | relay | `buzz-admin generate-key` (Secret key) | `BUZZ_RELAY_PRIVATE_KEY` — the relay's Nostr identity |
| `git-hook-hmac` | SecureString | relay | `openssl rand -hex 32` | `BUZZ_GIT_HOOK_HMAC_SECRET` |
| `redis-password` | SecureString | relay | `openssl rand -hex 24` | `REDIS_PASSWORD`; the chart composes `REDIS_URL` from it |
| `owner-pubkey` | String | relay | `buzz-admin generate-key` (Public key) | ArgoCD Application value `buzz.ownerPubkey` |
| `agent-key-<slug>` | SecureString | bridge | `buzz-admin generate-key` (Secret key) | one per ARIA agent identity (phase 0: `agent-key-aria`) |
| `aria-bot-api-token` | SecureString | bridge | aria-bot admin | bridge → `POST https://api.aria.arcadiaanalytics.com/tasks` |
| `arcadia-docs-mcp-token` | SecureString | bridge | arcadia-docs MCP admin | bridge → arcadia-docs HTTP MCP server |
| `aria-db-password` | SecureString | bridge | `openssl rand -hex 24` (`--apply` generates it) | the bridge Postgres **role** password: the bootstrap Job creates the role with it, ESO composes `ARIA_DATABASE_URL` from it (chart `database.passwordKeyName`) |
| `pilot-allowlist` | SecureString | bridge | a human writes it — `<pubkey-hex>:<aria_user_id>:<persona>[:<environment>]`, comma separated | `BUZZ_PILOT_ALLOWLIST` (chart `pilotAllowlist.fromSecret`) — the phase-0 execution gate |

`aria-db-password` is **not** the RDS master password. Crossplane owns that and
writes it into the connection Secret, which only the bootstrap Job ever reads;
the bridge Deployment holds a URL for its own least-privileged role and nothing
else. `pilot-allowlist` is the reason buzz membership confers no ARIA rights: an
unlisted pubkey gets a refusal and executes nothing, so the parameter must exist
(an empty value deploys fine and answers nobody).

The rows are **derived from the charts**, not retyped. `--verify` parses the
relay chart's `externalSecret.data` (exact match) and — when a sibling
`aria-frontend` checkout exists, or `ARIA_FRONTEND_REPO` points at one — the
bridge chart's `deploy/k8s/aria-buzz-bridge/values.yaml`, requiring the bridge
tier to cover every key that chart resolves (extra `agent-key-<slug>` params are
fine; a buzz environment can host several agent releases). If you add a secret to
either chart, `--verify` goes red until this list catches up — which is the
intended behaviour. Without a sibling checkout the bridge half is **skipped with
a warning**, so run the gate from a workspace that has both.

`git-hook-hmac` is required even though buzz git-forge is not adopted: the relay
rejects a secret shorter than 32 characters at startup (`config.rs:865`) and
`replicaCount: 2` on prd needs it present.

### Deliberately NOT in SSM

Each of these was wrong in an earlier draft of the plan; the reasons are load-bearing.

| Not created | Why |
|---|---|
| `database-url` | The Crossplane RDS endpoint does not exist until the first sync provisions the instance, and Crossplane writes `username`/`password`/`endpoint` as separate keys — it never emits a URL. The chart composes `DATABASE_URL` in the `ExternalSecret` target template from the connection Secret (decision **O3**). The *URL* is what is absent: the bridge role's password (`aria-db-password`, above) is an SSM parameter, because nothing else mints it. |
| `redis-url` | Composed in-chart from the Redis Service name + `redis-password`. |
| `s3-access-key`, `s3-secret-key` | Unprovisionable (a Crossplane `Bucket` claim mints no IAM user) **and** unnecessary — the relay falls back to the AWS default credential chain, i.e. IRSA, when both are empty (decision **D5**, node N18). Phase 0 has no media at all: `BUZZ_GIT_CONFORMANCE_PROBE=false`. |
| `litellm-key-*` | Fetched at runtime, per enrolled human, by the bridge. Not a deploy-time secret. |
| `owner-private-key` | See custody below. |

## Generating the material

```bash
# Dry run first — prints the exact put-parameter commands, generates nothing.
deploy/scripts/provision-secrets.sh --plan dev-ai

# Then, in the dev-ai account:
deploy/scripts/provision-secrets.sh --apply dev-ai --agents aria
deploy/scripts/provision-secrets.sh --verify dev-ai
```

`--apply` never overwrites an existing parameter (`--no-overwrite`), so re-running
it after a partial failure is safe and cannot silently replace a live relay
identity. Private keys are written to a `chmod 600` temp file and passed as
`--value file://…` — never on the command line, because GitHub/AWS log redaction
covers logs, not `ps auxww`.

`buzz-admin` is the **only** supported key generator (`crates/buzz-admin`) — there
is no `keygen` subcommand and hand-rolled secp256k1 material risks a key the
relay will not load. If you have no local build:

```bash
docker run --rm --entrypoint /usr/local/bin/buzz-admin \
  258174056699.dkr.ecr.us-east-1.amazonaws.com/buzz/relay:main-<sha> generate-key
```

## Key custody

**Relay identity (`relay-private-key`).** This is the relay's Nostr identity, not
a rotatable credential. Every event the relay has ever signed — kind:39000/39002
channel discovery, kind:13534 membership rosters — is bound to it. Rotating it
does not "change a password"; it produces a **different relay** that clients do
not recognise. Back it up when it is created:

1. `aws ssm get-parameter --name /ai-dev/dev-ai/buzz/relay-private-key --with-decryption`
2. Store in the team password manager under `buzz relay identity — dev-ai`,
   alongside the derived public key.
3. Record the date and the AIFM ticket number in the entry.

Also back up, per upstream's operator README: the Postgres database (the events
are the product), `git-hook-hmac`, `redis-password`, and the owner public key.

**Owner key.** `provision-secrets.sh --apply` prints the owner **secret** key once
and stores only the **public** half in SSM. Put the secret in the team password
manager before closing the terminal. It signs NIP-98 requests to
`POST /api/invites` (minting invite links) and nothing else — because
`buzz-admin add-member` writes the roster directly to Postgres, losing the owner
key costs the invite-link flow only. That is the whole reason it stays out of
SSM: a standing high-value secret at rest, in exchange for a convenience with a
documented break-glass, is a bad trade.

## Break-glass

| Situation | Procedure |
|---|---|
| Owner key lost | Roster changes continue via `kubectl -n buzz exec deploy/buzz -- buzz-admin add-member --pubkey <hex> --role member`. To restore invite minting, generate a new keypair, update `/…/buzz/owner-pubkey` **and** the Application's `buzz.ownerPubkey`, and sync. Existing members are unaffected — `owner` is a config value (`RELAY_OWNER_PUBKEY`), not a roster role. |
| Relay identity lost, no backup | Unrecoverable as an identity. Generate a new one, update SSM, restart. Clients see a new relay pubkey; historical relay-signed discovery events no longer verify. Channel and message data in Postgres survive intact. |
| Relay identity suspected compromised | Treat as a security incident, not a rotation. Rotate the key, then re-run `buzz-admin reconcile-channels` to re-sign discovery events under the new identity, and notify pilots that the relay pubkey changed. |
| Redis password rotation | Update SSM, wait for the ESO refresh (`refreshInterval: 1h`) or delete the Secret to force it, then restart the Redis Deployment **and** the relay (readiness pings Redis, so the relay goes NotReady until both agree). |
| A parameter was created with the wrong Type | `--verify` reports `BADTYPE`. Delete and recreate — ESO reads the value either way, but a `String` relay key is plaintext at rest in Parameter Store. |

## What `--verify` does and does not prove

It proves the parameters **exist and have the right type** in the right account.
It does not prove ESO can read them — that depends on the
`ClusterSecretStore/ssm-clustersecretstore` IRSA role, which is verified after
the first sync (node N7):

```bash
kubectl get externalsecret -n buzz buzz-secrets          # want: SecretSynced
kubectl get externalsecret -n buzz buzz-bridge-secrets   # want: SecretSynced (node N7b)
kubectl get secret -n buzz buzz-secrets -o jsonpath='{.data}' | tr ',' '\n' | cut -d'"' -f2
```

`--verify` reads types only, never `--with-decryption`: pulling relay identities
into a terminal (and its scrollback, and any recording of the change-control
session) to prove they exist is an exposure with no benefit.

## Expected first-sync behaviour

The RDS instance does not exist when the Application first syncs. Therefore:

- `buzz-secrets` reports `SecretSyncedError` while the Crossplane connection
  Secret is absent — the `DATABASE_URL` composition has no inputs yet.
- Relay Pods crash-loop until the instance is up (typically 10–15 minutes).

Both are expected and self-healing. Do not add `helm --wait` semantics, and do
not "fix" it by pre-creating a fake connection Secret.

## Checklist

- [ ] AIFM ticket exists, and its number is in `rds.jiraTicketNumber` in the Application
- [ ] Egress probes archived: `deploy/scripts/reachability.sh --env dev-ai --output …` (node N0a)
- [ ] `provision-secrets.sh --apply <cluster>` run in the correct account
- [ ] Relay identity + owner secret key in the team password manager
- [ ] `pilot-allowlist` written, with at least one real pilot pubkey (the bridge
      answers nobody without it)
- [ ] `provision-secrets.sh --verify <cluster>` exits 0 — from a workspace that
      also has `aria-frontend`, so the bridge-tier drift check actually runs
- [ ] `buzz.ownerPubkey` in the Application matches `/…/buzz/owner-pubkey`
- [ ] Relay image tag in the Application is a tag that exists:
      `aws ecr describe-images --repository-name buzz/relay --image-ids imageTag=main-<sha>`
- [ ] prd only: approved ACM CR referenced in the PR body; deployer ≠ implementer
