# Privacy Review — ARIA × buzz team chat (relay + bridge)

**Scope:** the buzz relay deployed on dev-ai and prd-ai EKS, and the ARIA↔buzz
bridge that answers @mentions in buzz channels by executing ARIA skills. Covers
what ends up in the relay's event store, who can read it, how long it lives, and
what the bridge logs.

**Spec:** `aria-workspace/buzz-frontend-pivot.SPEC.md` — node **N16**, risk
**R4**, decisions D4/D5/D7/D9/D11.

**Engineering owner:** Brendan Smith-Elion (`bse-ai`).
**Security reviewer:** _pending — please route._

**This document is a phase-2 gate (G3).** prd cannot go live without sign-off
here. Until then, prd agents run read-only, non-clinical skills only.

---

## 0. The one-paragraph version

buzz is a Nostr relay. Every chat message is an event row in Postgres with its
body in **plaintext**, replicated to every member of the channel, **full-text
indexed**, and retained **indefinitely** unless the channel was explicitly
created ephemeral. ARIA's replies are ordinary `kind:9` channel messages and get
exactly the same treatment. ARIA skills query Foundry/QDW/claims-adjacent
systems, so an unguarded reply can move PHI-adjacent content into a searchable,
member-readable, long-lived log. The controls are: **channel membership is the
data scope**, **the network boundary is the auth boundary**, **execution
authorization is fail-closed at the bridge**, and — the primary control —
**PHI-free by construction in what the agent is allowed to run**. Retention is
the weakest leg and is stated honestly in §4.

## 1. What data lands where

### 1.1 The relay event store (Postgres, `events`)

| Field | Contains | Notes |
|---|---|---|
| `content` | **the full message body, plaintext** | Both the human's question and ARIA's answer. `kind:9` = channel message. |
| `pubkey` | author's Nostr public key | Pseudonymous on its own; the bridge's enrollment table maps it to an Entra UPN (§1.3). |
| `kind`, `tags`, `created_at`, `id`, `sig` | protocol metadata | `h` = channel, `e` = thread root, `p` = mention target. |
| `channel_id`, `community_id` | scoping | Enforced on every read path. |
| `search_tsv` | tokenized `content` | See §3 — this is the FTS surface. |

There is no field-level encryption for `kind:9`. NIP-17 gift-wrapped DMs
(`kind:1059`) are ciphertext, but the team-chat flow this spec builds does not
use them.

### 1.2 The audit log (Postgres, `audit_log`)

Per-community hash chain, on by default and pinned on
(`BUZZ_AUDIT_ENABLED=true`). Verified contents — **structural metadata only, no
message content**:

- event publish (`crates/buzz-relay/src/handlers/event.rs:592`):
  `{event_kind, channel_id}` + `actor_pubkey` + `object_id` (the event id).
- media upload (`crates/buzz-relay/src/api/media.rs:431`):
  `{sha256, size, mime}`.

Adding a field to `detail` is a privacy-review-triggering change. Say so in the PR.

### 1.3 The bridge (aria-frontend `apps/bridge`)

- `nostr_thread` — maps `(channel h-tag, thread root e-tag)` → ARIA conversation
  id → `cc_session_id`. Identifiers only.
- `enrollments` (node N12) — `pubkey → entra_upn → persona_tier`. **This is the
  re-identification table**: it is what turns a pseudonymous Nostr pubkey into a
  named employee. Same database, same encryption, same access controls; treat it
  as the most sensitive table in the deployment.
- The ARIA conversation store — unchanged from the existing web door; the bridge
  reuses `apps/bff/app/store.py` rather than forking it.

### 1.4 Redis

Pub/sub fan-out between relay replicas, plus rate-limit counters and membership
caches. Its data directory is an `emptyDir` — node-local and destroyed with the
Pod. It is password-authenticated (`REDIS_PASSWORD` from SSM) and reachable only
from relay Pods (NetworkPolicy). Pub/sub payloads are not part of the keyspace,
so they are not snapshotted; the exact key inventory is **open question Q4**.

### 1.5 Media / S3

**None.** Phase 0 ships no object storage: no bucket claim, no endpoint, no
credentials, and the git-on-object-storage conformance probe is off
(`BUZZ_GIT_CONFORMANCE_PROBE=false`). Node N18 would add a bucket via a
Crossplane claim with IRSA — **that is a separate privacy review**, because
attachments are the fastest route from "a screenshot of a member record" to "an
object in a bucket".

## 2. Where it lands, and who can reach it

- **Postgres:** RDS 17 via a Crossplane claim, `storageEncrypted: true`,
  `deletionProtection: true`, `deletionPolicy: Orphan`. dev-ai in account
  `258174056699`, prd-ai in `572630832277`, us-east-1. **No shared state between
  environments** — separate instances, separate relay identities, separate
  rosters. buzz communities are host-scoped and a host is authoritative.
- **Network:** internal ALB only (`scheme: internal`), reachable over the corp
  VPN. Never internet-facing. NetworkPolicy restricts relay ingress to the
  environment's real VPC CIDRs (`10.54.0.0/17`+`10.54.128.0/17` dev,
  `10.52.0.0/17`+`10.52.128.0/17` prd — not `10.0.0.0/8`, which is not a
  boundary), and Redis to relay Pods only.
- **Relay auth:** NIP-42 signature challenge plus roster membership
  (`BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`). REST requires token auth
  (`BUZZ_REQUIRE_AUTH_TOKEN=true`). Media GET requires Blossom auth **and**
  membership (`BUZZ_REQUIRE_MEDIA_GET_AUTH=true` — we flip this from the
  upstream default of false).
- **Read scope:** channel membership. Every search and every read filters on the
  caller's accessible channels (`crates/buzz-search/src/query.rs` — the query
  builder takes an `accessible_channels` list and there is no path around it).
  **Channel membership is therefore the data-scoping primitive**: per-team and
  per-domain channels, agents added per channel by admins.
- **Execution authorization** is a *separate* decision from read access, made in
  the bridge and **fail-closed**: pubkey → Entra UPN → AT-16 persona tier. An
  unenrolled pubkey gets a refusal and **zero** `SessionManager` calls (asserted
  in test, node N12). Relay membership never confers ARIA execution rights.
- **Secrets:** ESO from SSM Parameter Store, split by tier — relay Pods never
  mount agent private keys and the bridge never mounts the relay identity
  (decision D12). `DATABASE_URL` is composed in-cluster from the Crossplane
  connection Secret and never exists as an SSM parameter.

## 3. Full-text search — the statement

**ARIA replies are searchable.** This is a design fact, not an oversight, and it
is the sharpest edge of risk R4.

buzz maintains a `search_tsv` generated column on `events` with a GIN index. Two
expressions exist in the codebase:

- Fresh installations (dev-ai and prd-ai both start empty, so this is ours) get a
  **positive allowlist** — `migrations/0008_fresh_install_search_allowlist.sql`:

  ```sql
  CASE WHEN kind IN (0, 9, 40002, 45001, 45003)
       THEN to_tsvector('simple', content) ELSE NULL END
  ```

- Pre-existing installations keep the older **exclusion list**
  (`migrations/0005_agent_turn_metric_fts.sql`): kinds `1059`, `30300`, `30622`,
  `44100`, `44101`, `44200` are excluded as privacy-sensitive.

`kind:9` is a channel message. It is in the allowlist and it is **not** in the
privacy-excluded set. So: every human question and every ARIA answer in a channel
is tokenized and indexed. `kind:0` (profiles) too.

Mitigations, in force order:

1. **Search results are channel-scoped.** The FTS query is `AND`-ed with the
   caller's accessible channels, so the index does not widen who can read what —
   it widens *how easily* a member can find it inside channels they are already
   in. That is a real but bounded increase in exposure.
2. **PHI-free by construction.** Same posture aria-bot arrived at after issue
   #598 (11 of 101 graded tickets carried patient identifiers in ARIA-authored
   comments): the primary control is that the agent authors from structured
   hydration and references records by key, rather than copying record text.
   Phase 0/1 agents run read-only, non-clinical skills.
3. **Channel scoping as data scoping.** PHI-adjacent work happens in
   membership-gated channels, not in a general channel.
4. **A bridge-side output scrubber** — recommended, not yet built. See Q1.

If a message is posted that should not have been, note that **deleting the row is
the only remedy** — a NIP-09 deletion request soft-deletes and the `search_tsv`
generated column follows the row, but there is no "unindex, keep the message"
operation.

## 4. Retention — stated honestly

**Default retention for a normal channel is indefinite.** buzz has no global
event-retention setting and no event reaper. This is the weakest control in the
deployment and it should not be signed off as if it were solved.

What the relay actually offers, and what we set:

| Control | Chart value | Effect |
|---|---|---|
| Ephemeral-channel TTL ceiling | `buzz.relay.ephemeralTtlOverride: 604800` (7 days) | Only channels created **with** a TTL tag. Idle-based: the deadline resets on every durable message, so an active channel never expires. |
| Audit log | `BUZZ_AUDIT_ENABLED=true` | Append-only hash chain, metadata only, no purge mechanism. |
| Media | none deployed | N18 will need its own lifecycle policy. |
| RDS backups | `preferredBackupWindow: 02:00-03:00` | Automated snapshots extend effective retention beyond any application-level deletion. **A row deleted from `events` still exists in every snapshot taken before the deletion.** |

Three properties of the TTL setting that must not be overstated, all verified in
source:

1. **It is an override, not a cap** (`crates/buzz-relay/src/config.rs:691-701`).
   A channel created asking for 1 hour also gets 7 days. It bounds the long tail
   at the cost of lengthening a deliberately-short request. A true
   `min(client, org)` cap is an upstream contribution candidate.
2. **It archives; it does not delete.** The reaper runs
   `UPDATE channels SET archived_at = NOW()`
   (`crates/buzz-db/src/channel.rs:1387-1401`). The channel disappears from
   clients; the rows in `events` remain, and remain FTS-indexed. There is no
   event purge in the product.
3. **It does not touch permanent channels at all.** A channel created without a
   TTL tag is retained for the life of the database.

**Consequence, plainly:** the ARIA team channels this spec creates are permanent
channels, so their message bodies are retained indefinitely with no built-in
expiry. A defensible retention policy requires either (a) a scheduled purge job
against `events` — net-new work, and it must handle the FTS index and the
hash-chained audit log coherently — or (b) an accepted-risk decision that chat
history is retained for the life of the deployment, with channel scoping and
PHI-free-by-construction as the compensating controls. **That decision belongs
to Security, not to engineering. It is open question Q2 and it gates prd.**

## 5. Bridge logging — the allowlist

The bridge logs **structural fields only**. Same posture as aria-bot's
post-#598 stance: assume anything a person could have typed, or that a tool
could have read, is PHI until proven otherwise.

| Logged | Never logged |
|---|---|
| event id, kind, `created_at` | `content` — of the mention or of the reply |
| channel id, thread root id | channel *name* (free text, may name a customer) |
| author pubkey (first 16 hex) | full pubkey at info level; Entra UPN |
| ARIA conversation id, `cc_session_id` | prompt text, system prompt, thinking blocks |
| tool **name**, allow/deny decision | tool **input** or tool **result** bodies |
| token counts, latency, queue depth | skill arguments |
| refusal *reason code* (e.g. `unenrolled`) | the message that was refused |

Verification (node N16 acceptance criterion) — this must be a CI check, not a
one-off grep:

```bash
# in aria-frontend
rg -n 'log(ger)?\.(info|warning|error|debug).*\b(content|text|prompt|body|message)\b' apps/bridge/
```

Any hit needs a comment on the line explaining why the field is structural, or
the log statement changes. The same rule applies to exception paths: a traceback
that formats an event object will print its `content`, so the bridge must log
`repr(exc)` and identifiers, never the event.

`RUST_LOG=info` on the relay: relay logs carry event ids and pubkeys, not
bodies. Loki retention is the platform default and is outside this review.

## 6. Threat model

| # | Threat | Mitigation | Residual |
|---|---|---|---|
| T1 | PHI in an ARIA reply lands in a searchable, permanent event log | PHI-free by construction (skills author from structured hydration); phase 0/1 agents read-only non-clinical; channel scoping | **Real.** No output scrubber yet (Q1); no purge (Q2) |
| T2 | A channel member reads data they should not | Channel membership is the read scope, enforced on every read and search path; agents added per channel by admins | Depends on channel hygiene — a too-broad channel is a too-broad audience |
| T3 | A buzz member with no ARIA rights gets ARIA to execute | Execution authz is separate from relay membership and fail-closed: pubkey → Entra → AT-16 tier; unenrolled ⇒ refusal, zero SessionManager calls (asserted in test, N12) | Low |
| T4 | Privilege escalation via the agent's own identity | Execution runs under the **requesting human's** persona tier and environment, never a service persona; AT-16 hooks, `strict_mcp_config=True`, tool_policy approval gate | Low |
| T5 | Write-capable tool runs without a human decision | Approvals over chat (N11): threaded prompt, resolvable **only** by the requesting pubkey, deny on timeout; 104/110 skills are `disable-model-invocation: true` | Low |
| T6 | Relay reachable from the internet | `scheme: internal` ALB, VPN-only, NetworkPolicy on real VPC CIDRs, relay membership required | Low |
| T7 | Nostr pubkey → named employee | The `enrollments` table is the only mapping; same DB, same encryption, restricted like the rest | Low, but it is the re-identification key — treat accordingly |
| T8 | Lost/stolen device key | Keys are self-custodied on user devices. Revocation = `buzz-admin remove-member` + enrollment delete (§7). Historical messages authored by that key remain | Accepted; offboarding SLA is the control |
| T9 | Message bodies leak through logs | §5 allowlist + the CI grep | Low, if the grep is actually wired into CI |
| T10 | Deleted messages survive in RDS snapshots | Nothing prevents this; automated backups are a compliance requirement in their own right | **Accepted and must be stated in any deletion promise** — see Q3 |
| T11 | Media/attachment PHI | No media exists in phase 0. `BUZZ_REQUIRE_MEDIA_GET_AUTH=true` and `uploadRecords: false` are pre-set so N18 starts from the closed position | Deferred to N18's own review |
| T12 | Cross-environment leakage dev↔prd | Separate relay identities, DBs, rosters and accounts; communities are host-scoped and no agent state is inherited across hosts | Low |
| T13 | Client IP/port recorded on upload | `relay.uploadRecords: false`, and the IP/PORT header knobs are unset | Low |
| T14 | An operator reads the event store directly | RDS access is IAM/SSO-gated and CloudTrail-logged like every other Arcadia database | Standard |

## 7. Offboarding runbook

When a pilot leaves the team, loses a device, or has access revoked, in this
order:

1. **Revoke relay access** (stops all reading and writing immediately):
   ```bash
   kubectl -n buzz exec deploy/buzz -- buzz-admin remove-member --pubkey <64-hex>
   kubectl -n buzz exec deploy/buzz -- buzz-admin list-members    # confirm
   ```
   This also republishes the `kind:13534` roster to live clients.
2. **Revoke ARIA execution rights** — delete the row from `enrollments` (node
   N12's admin CLI, `apps/bridge/local/enroll.py`). Belt and braces: a pubkey
   that is off the roster cannot connect, but the enrollment row is the thing
   that grants *execution*, and the two must not drift.
3. **Channel membership** — removal from the relay roster does not by itself
   tidy per-channel membership rows. Remove them so a re-added identity does not
   silently regain old channels.
4. **Their messages remain.** Nostr events are signed and content-addressed;
   there is no "delete everything by this author" operation, and the audit hash
   chain deliberately resists selective edits. If a deletion is legally required,
   it is a DBA operation against `events` plus every RDS snapshot in the window —
   scope it as an incident, not a runbook step.
5. **A lost key is a new identity.** Nostr keys are self-custodied; there is no
   recovery. The person re-enrolls with a new pubkey, which is a fresh row in
   `enrollments` and a fresh `buzz-admin add-member`. Their history stays under
   the old pubkey.

Relay-side and owner-side key custody, rotation, and break-glass are in
`deploy/charts/buzz-arcadia/PREFLIGHT.md`.

## 8. Open questions for Security

1. **Q1 — Output scrubber.** Should the bridge run a PHI backstop over ARIA's
   reply text before publishing it, mirroring
   `aria-bot/airflow/dags/helpers/automations/autonomous_act/phi_scrub.py`? It
   is local, makes no service round-trip, and redacts labelled identifiers. Cost:
   false positives redact legitimate content mid-conversation, which is more
   visible in chat than in a ticket comment. Engineering recommends **yes**, with
   the redaction visible to the requester.
2. **Q2 — Retention decision (gates prd).** Either commission a purge job for
   `events` (net-new; must handle FTS and the audit chain), or accept indefinite
   retention with channel scoping plus PHI-free-by-construction as the
   compensating controls. §4 has the constraints. Engineering cannot make this
   call.
3. **Q3 — Deletion promises vs backups.** Any retention commitment we publish has
   to account for RDS automated snapshots, which outlive row deletion. What is
   the sanctioned wording?
4. **Q4 — Redis key inventory.** Confirm no message body is written to a Redis
   *key* (as opposed to transiting pub/sub). Pub/sub payloads are not in the
   keyspace and the data dir is an `emptyDir`, but the cache and presence
   modules have not been enumerated key-by-key.
5. **Q5 — Data classification.** Should the buzz `events` table be classified
   "Internal-Restricted" in the catalog, and should the `enrollments` table carry
   a stricter class than the schema around it?
6. **Q6 — Desktop client.** Clients hold a local replica of every channel they
   are in, on managed laptops. Is disk encryption + MDM sufficient, or does the
   client need its own review? Note the auto-updater points at Block's GitHub
   (decision O1 — consume Block-signed releases under a written updater policy),
   so client behaviour can change without our release gate.

---

## Status

**Awaiting routing to the Security review group.** Blocking for prd (gate G3).

Configuration asserted by this review is enforced in
`deploy/charts/buzz-arcadia/values.yaml` and renders in **both** environments:

```bash
helm template buzz deploy/charts/buzz-arcadia -n buzz \
  -f deploy/charts/buzz-arcadia/ci/prd-ai-values.yaml \
  | grep -E 'BUZZ_(EPHEMERAL_TTL_OVERRIDE|AUDIT_ENABLED|REQUIRE_MEDIA_GET_AUTH|REQUIRE_AUTH_TOKEN|REQUIRE_RELAY_MEMBERSHIP)'
```

Expected: `604800`, `true`, `true`, `true`, `true`.

Helm **replaces** lists rather than merging them, so an Application that sets
`buzz.relay.extraEnv` drops every default in one edit. If this review's controls
ever stop rendering, look there first.
