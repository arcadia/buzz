# SMOKE — phase-0 verification, membership bootstrap, and soak

Spec node **N8**. Run after `buzz` and `aria-buzz-bridge` are both `Synced/Healthy`
in ArgoCD. Pre-flight (SSM parameters, key custody) is `PREFLIGHT.md`.

```bash
deploy/scripts/smoke-e2e.sh wss://buzz.ai-dev.arcadiaanalytics.com
deploy/scripts/smoke-e2e.sh wss://buzz.ai-dev.arcadiaanalytics.com --team    # phase 1
deploy/scripts/soak-metrics.sh -n buzz -o soak.csv --duration 24h
deploy/scripts/soak-metrics.sh --summary soak.csv
```

## 0. Preconditions

```bash
kubectl -n argocd get application buzz aria-buzz-bridge \
  -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.sync.status}{" "}{.status.health.status}{"\n"}{end}'
kubectl -n buzz get externalsecret               # buzz-secrets + buzz-bridge-secrets: SecretSynced
kubectl -n buzz get pods
```

You must be **on the VPN**. The ALB is `scheme: internal` by design — the
network boundary is the auth boundary (decision D4), so "I cannot reach the
host" from a coffee shop is the control working.

## 1. Membership bootstrap

The relay runs with `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true`, so an unknown pubkey
cannot connect at all. Roster roles are **`admin` or `member` only** —
`owner` is a config value (`RELAY_OWNER_PUBKEY`, i.e. the chart's
`buzz.ownerPubkey`), not a roster role, and `bot` is a *channel* member role,
not a relay one.

```bash
# humans (pilots)
kubectl -n buzz exec deploy/buzz -- buzz-admin add-member --pubkey <64-hex> --role member
# the ARIA agent identities (public halves of /…/buzz/agent-key-<slug>)
kubectl -n buzz exec deploy/buzz -- buzz-admin add-member --pubkey <agent-hex> --role member
kubectl -n buzz exec deploy/buzz -- buzz-admin list-members
```

Add members **serially**. `buzz-admin` bumps the kind:13534 roster snapshot's
timestamp to `max(now, newest + 1s)` to defeat same-second domination, which
protects serial invocations but not concurrent ones — two parallel adds can read
the same newest timestamp and collide. Do not `xargs -P` this.

Record the roster in `deploy/scripts/agents.roster` (git-ignored, or kept in the
runbook ticket) so `smoke-e2e.sh` can check it:

```
# slug   pubkey (64 lowercase hex)
aria     <agent pubkey>
```

## 2. Invites (the human path)

`POST /api/invites` is NIP-98-signed and callable by owner/admin only; the claim
side (`POST /api/invites/claim`) is deliberately exempt from membership. The
supported pilot path is the bundled web UI's `invite.$code` route — open
`https://buzz.ai-dev.arcadiaanalytics.com` on the VPN and use the invite flow.

`smoke-e2e.sh --mint-invite` will try to mint one programmatically, but NIP-98
(kind 27235) is **outside** the bridge client's scope (node N3 covers NIP-01 and
NIP-42), so treat that flag as best-effort: if the helper does not implement it,
the step SKIPs and you use the web flow.

## 3. Scripted round-trip

`smoke-e2e.sh` does not reimplement a Nostr client. It shells out to the bridge's,
in aria-frontend:

```bash
export ARIA_FRONTEND_ROOT=/path/to/aria-frontend
export BUZZ_SMOKE_SECRET_KEY=<64-hex secret key of an ENROLLED pilot human>
deploy/scripts/smoke-e2e.sh wss://buzz.ai-dev.arcadiaanalytics.com
```

Checks, in order:

| # | Check | Fails when |
|---|---|---|
| 1 | `/_readiness` on :8080 for every Pod | Postgres or Redis unreachable from that Pod |
| 2 | NIP-11 document over the public host | ALB target group unhealthy, DNS missing, off VPN |
| 3 | Roster contains every pubkey in the roster file | a pilot or agent was never added |
| 4 | Threaded kind:9 reply with `h` + root `e` + `p` tags | bridge down, mention gate wrong, threading broken |
| 5 | 10-message burst without `rate-limited: quota exceeded` | limiter misconfigured, or Redis is unhealthy |
| 6 | `--team`: only the mentioned agent replies | the `p`-tag mention gate is not exact |

**Skips are not passes.** The script counts them separately and says so; a green
exit with skips does not satisfy the phase-0 exit criteria.

### Client contract

`smoke-e2e.sh` expects `$ARIA_FRONTEND_ROOT/apps/bridge/local/smoke_mention.py`
(spec node N4) to accept:

```
--relay-url <wss://host>     public URL: the Host header AND the NIP-42 relay tag
--dial-url <ws://…>          optional in-cluster dial target (default: relay-url)
--secret-key-env <NAME>      env var holding the 64-hex secret key (never a flag)
--channel <name|uuid>
--mention <agent-pubkey-hex> the p tag that gates the agent
--text <string>
--burst <n>                  publish n messages (default 1)
--timeout <secs>
--json                       emit exactly one JSON object on stdout
```

and to emit:

```json
{
  "ok": true,
  "channel": "<uuid>",
  "root_event_id": "<hex>",
  "mention_pubkey": "<hex>",
  "rate_limited": false,
  "elapsed_ms": 1234,
  "replies": [
    {"id": "<hex>", "pubkey": "<hex>", "kind": 9,
     "tags_h": "<channel>", "tags_e": ["<root>"], "tags_p": ["<requester>"]}
  ],
  "error": null
}
```

`ok` is true only when at least one threaded kind:9 reply arrived before the
timeout. `rate_limited` is true if any `NOTICE`/`CLOSED` beginning
`rate-limited:` was seen. `replies` lists **every** kind:9 in the thread —
including replies from agents that were not mentioned, which is precisely what
the `--team` matrix inspects.

## 4. Desktop client session (human, required)

Change-control audit rules want evidence a real client works, not only a script.

1. Install the desktop app per the node N0b distribution decision (Block-signed
   upstream release + written updater policy, decision O1 — the client will take
   Block updates; version pinning is impossible without forking the release
   pipeline).
2. Connect to `wss://buzz.ai-dev.arcadiaanalytics.com` over the VPN.
3. Claim the invite, create a channel, add the ARIA agent to it.
4. @mention the agent; confirm the reply threads under your message.
5. **Screenshot with a visible timestamp**, archived on the AIFM ticket.

## 5. Soak (24 h)

```bash
nohup deploy/scripts/soak-metrics.sh -n buzz -o soak.csv --duration 24h &
# later
deploy/scripts/soak-metrics.sh --summary soak.csv
```

Scrapes `:9102/metrics` through the API-server Pod proxy (a pure read — no exec,
nothing needed inside the container) and appends one CSV row per Pod per tick.

There is **no Prometheus** on these clusters — no Prometheus Operator, therefore
no ServiceMonitor/PodMonitor CRD; `buzz.serviceMonitor.enabled` is `false`
always. Real scraping is Alloy River config in cloud-config-templates (node N14,
platform-infra tier, SRE ticket). This script exists so the R2 soak evidence does
not sit behind that queue.

Columns and what they mean:

| Column | Kind | Reads as |
|---|---|---|
| `buzz_ws_connections_active` | gauge | the soak signal |
| `buzz_total_ws_connections` | gauge | cluster-wide total |
| `buzz_ws_backpressure_disconnects_total` | counter | slow-client evictions — an **explained** drop |
| `buzz_ws_auth_timeouts_total` | counter | clients that never finished NIP-42 |
| `buzz_auth_attempts_total` | counter | **reconnect proxy** — see below |
| `buzz_auth_failures_total` | counter | bad/expired NIP-42 |
| `buzz_admission_rejections_total` | counter | rate-limit rejections (all label values summed) |
| `buzz_events_received_total` | counter | traffic denominator |
| `buzz_db_pool_active` | gauge | Postgres pressure — the metric the litellm `db.t3.medium` RCA turned on |

The relay has **no reconnect counter**. `buzz_auth_attempts_total` stands in:
every new WebSocket connection re-runs NIP-42, so a rising auth rate against a
flat connection gauge is a reconnect storm. Do not report it as a literal
reconnect count.

`--summary` classifies each drop in `buzz_ws_connections_active`:

- **explained** — `buzz_ws_backpressure_disconnects_total` rose in the same
  window (a slow client was evicted; working as designed).
- **unexplained** — it did not. That is the ALB idle-timeout / VPN-MTU /
  deploy-drain signature the soak is hunting, and it makes the verdict red.

Annotate deploys: a rollout drains connections and shows up as an unexplained
drop. Note the times in the ticket alongside the CSV.

## 6. Phase-0 exit criteria

- [ ] `buzz` and `aria-buzz-bridge` `Synced/Healthy`; `/_readiness` 200 from all Pods
- [ ] `smoke-e2e.sh` exits 0 **with no skips**
- [ ] a real skill-shaped read task answered in-channel with correct threading
- [ ] bridge Pod restart does not lose conversation continuity (resume via
      `cc_session_id` through the bridge's Postgres `nostr_thread` map — needs
      `ARIA_DATABASE_URL` set; without it `store.py` silently falls back to
      per-Pod SQLite and every deploy drops the map)
- [ ] 24 h soak CSV captured, `--summary` clean
- [ ] `reachability.sh` egress probes archived (node N0a)
- [ ] desktop screenshot with timestamp archived

## Troubleshooting

| Symptom | Cause |
|---|---|
| WS upgrade 404s | `Host` header is not the mapped community host. The relay binds a community from `Host` **before** the upgrade (`router.rs:280-298`); an in-cluster dial must send `Host: buzz.<env-domain>`. |
| NIP-42 `AUTH` rejected | The `relay` tag must be `<scheme-from-config>://<Host>` — i.e. `BUZZ_RELAY_PUBLIC_URL`, never the dialled socket URL (`api/bridge.rs:225-232`); ±60 s clock skew (`nip42.rs:35`). |
| ALB targets all unhealthy | Health check must be `:8080/_readiness`. `/` on `:3000` sends the target **IP** as `Host`, which is unmapped, so every target 404s and is marked down. |
| `rate-limited: quota exceeded` | Standalone agents authenticate with no `agent_owner_pubkey`, so they are metered at the **human** tier: 60 msg/min, 10 WS events/s. Decision O2 accepts that and paces bridge replies. The limiter also fails **closed** on Redis errors — check Redis before blaming traffic. |
| Everything NotReady at once | Redis. It is a single in-cluster Pod in both environments (accepted SPOF, decision O4) and relay readiness pings it, so one restart flips every replica. prd ElastiCache is a tracked follow-up (SRE-4216/17/18), not a phase-0 blocker. |
| `SecretSyncedError` on first sync | Expected: the Crossplane RDS endpoint does not exist yet, so the `DATABASE_URL` composition has no inputs. Self-heals in 10–15 minutes. |
