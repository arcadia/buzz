#!/usr/bin/env bash
# Phase-0 end-to-end smoke for the buzz relay + ARIA bridge (spec node N8).
#
# WHAT THIS PROVES
# ----------------
#   1. Every relay Pod is ready (/_readiness on :8080 — Postgres AND Redis).
#   2. The public host actually terminates at the relay through the internal ALB
#      (risk R2: this is the first WebSocket workload behind an ALB on these
#      clusters — there is no precedent on dev-ai or prd-ai).
#   3. The relay roster contains the pilot humans and the agent identities.
#   4. A synthetic human can @mention an ARIA agent and get a correctly THREADED
#      kind:9 reply back (`h` channel tag, root `e` tag, requester `p` tag).
#   5. A 10-message burst does not trip the relay rate limiter.
#   6. --team: each agent answers ONLY its own mentions (the cross-mention
#      matrix from node N10's acceptance criteria).
#
# WHAT IT DOES NOT PROVE, and where that lives instead
# ----------------------------------------------------
#   * The desktop client works. That is a human step with a timestamped
#     screenshot — SMOKE.md §4, required by change-control audit rules.
#   * Long-lived connection stability. That is soak-metrics.sh over 24 h.
#   * Invite minting signs a NIP-98 request with the OWNER secret key. This
#     script will do it with --mint-invite if a signer is available, but the
#     supported pilot path is the web invite-claim flow, not a script.
#
# THE SYNTHETIC HUMAN
# -------------------
# Steps 4-6 need a real Nostr client: NIP-42 auth, kind:9 publish, subscription,
# tag inspection. That client is the bridge's, in the OTHER repo — this script
# does not reimplement it. It shells out to:
#
#   $ARIA_FRONTEND_ROOT/apps/bridge/local/smoke_mention.py     (spec node N4)
#
# and reads its --json result. The exact CLI contract is documented in SMOKE.md
# §Client contract; if that script is missing, the round-trip steps are SKIPPED
# with a loud notice rather than silently passing.
#
# USAGE
#   deploy/scripts/smoke-e2e.sh wss://buzz.ai-dev.arcadiaanalytics.com
#   deploy/scripts/smoke-e2e.sh wss://buzz.ai-dev.arcadiaanalytics.com --team
#   deploy/scripts/smoke-e2e.sh wss://... --channel ops --agent <64-hex>
#
# FLAGS
#   --team                cross-mention matrix over every agent in the roster
#   --roster <file>       "<slug> <pubkey-hex>" per line, # comments allowed
#                         (default: $BUZZ_AGENT_ROSTER, else deploy/scripts/agents.roster)
#   --agent <hex>         single-agent mode target (default: first roster entry)
#   --channel <name>      channel to post in (default: smoke)
#   --namespace <ns>      Kubernetes namespace (default: buzz)
#   --release <name>      Helm release name (default: buzz)
#   --burst <n>           burst size for the rate-limit check (default: 10)
#   --timeout <secs>      reply wait per mention (default: 120)
#   --mint-invite         also mint an invite code (needs BUZZ_OWNER_SECRET_KEY)
#   --skip-cluster        skip kubectl-dependent steps (1 and 3)
#   --output <file>       tee the transcript for the change-control record
#
# ENVIRONMENT
#   ARIA_FRONTEND_ROOT      path to the aria-frontend checkout (required for 4-6)
#   BUZZ_SMOKE_SECRET_KEY   64-hex secret key of the synthetic human. MUST be
#                           enrolled + a relay member, or the bridge refuses it
#                           (that refusal is itself a passing authz test — see
#                           SMOKE.md §Unenrolled).
#   BUZZ_OWNER_SECRET_KEY   only for --mint-invite
#
# EXIT CODES
#   0  all executed checks passed
#   1  a check failed
#   2  usage / tooling error

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

RELAY_URL=""
TEAM=false
ROSTER="${BUZZ_AGENT_ROSTER:-${REPO_ROOT}/deploy/scripts/agents.roster}"
AGENT=""
CHANNEL="smoke"
NAMESPACE="${NAMESPACE:-buzz}"
RELEASE="${RELEASE:-buzz}"
BURST=10
TIMEOUT=120
MINT_INVITE=false
SKIP_CLUSTER=false
OUTPUT=""

die()  { printf 'FAIL: %s\n' "$*" >&2; exit 2; }
pass() { printf '  PASS  %s\n' "$*"; }
fail() { printf '  FAIL  %s\n' "$*"; FAILURES=$((FAILURES + 1)); }
skip() { printf '  SKIP  %s\n' "$*"; SKIPPED=$((SKIPPED + 1)); }
step() { printf '\n== %s\n' "$*"; }

FAILURES=0
SKIPPED=0

while [ $# -gt 0 ]; do
  case "$1" in
    wss://*|ws://*) RELAY_URL="$1"; shift ;;
    --team)         TEAM=true; shift ;;
    --roster)       ROSTER="${2:?}"; shift 2 ;;
    --agent)        AGENT="${2:?}"; shift 2 ;;
    --channel)      CHANNEL="${2:?}"; shift 2 ;;
    --namespace|-n) NAMESPACE="${2:?}"; shift 2 ;;
    --release)      RELEASE="${2:?}"; shift 2 ;;
    --burst)        BURST="${2:?}"; shift 2 ;;
    --timeout)      TIMEOUT="${2:?}"; shift 2 ;;
    --mint-invite)  MINT_INVITE=true; shift ;;
    --skip-cluster) SKIP_CLUSTER=true; shift ;;
    --output)       OUTPUT="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,60p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$RELAY_URL" ] || die "give the public relay URL, e.g. wss://buzz.ai-dev.arcadiaanalytics.com"
[ -n "$OUTPUT" ] && exec > >(tee "$OUTPUT") 2>&1

# The public host is load-bearing everywhere: the relay binds a community from
# the Host header BEFORE the WebSocket upgrade and 404s an unmapped host
# (crates/buzz-relay/src/router.rs:280-298), and the NIP-42 `relay` tag must be
# <scheme-from-config>://<Host>, not the socket that was dialled.
RELAY_HOST="${RELAY_URL#*://}"
RELAY_HOST="${RELAY_HOST%%/*}"
HTTPS_URL="https://${RELAY_HOST}"

printf 'buzz phase-0 smoke — node N8\n'
printf '  relay      : %s (host %s)\n' "$RELAY_URL" "$RELAY_HOST"
printf '  namespace  : %s   release: %s\n' "$NAMESPACE" "$RELEASE"
printf '  mode       : %s\n' "$([ "$TEAM" = true ] && echo 'team cross-mention matrix' || echo 'single agent')"
printf '  timestamp  : %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 1. relay readiness, every Pod ───────────────────────────────────────────
step "1. relay readiness (:8080/_readiness on every Pod)"
if [ "$SKIP_CLUSTER" = true ]; then
  skip "--skip-cluster"
elif ! command -v kubectl >/dev/null 2>&1; then
  skip "kubectl not on PATH"
else
  PODS="$(kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=buzz" \
            -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if [ -z "$PODS" ]; then
    fail "no relay Pods matched app.kubernetes.io/name=buzz in ${NAMESPACE}"
  else
    while read -r pod; do
      [ -n "$pod" ] || continue
      # The relay image ships curl, so this needs nothing mounted in.
      # /_readiness gates on BOTH Postgres and Redis and has no Host binding —
      # unlike "/" on :3000, which 404s any unmapped Host and would look broken.
      if kubectl -n "$NAMESPACE" exec "$pod" -- \
           curl -sf --max-time 5 http://localhost:8080/_readiness >/dev/null 2>&1; then
        pass "$pod ready"
      else
        fail "$pod NOT ready — kubectl -n ${NAMESPACE} exec ${pod} -- curl -s localhost:8080/_readiness"
      fi
    done <<< "$PODS"
  fi
fi

# ── 2. the public host reaches the relay ────────────────────────────────────
step "2. public host through the internal ALB (risk R2)"
if ! command -v curl >/dev/null 2>&1; then
  skip "curl not on PATH"
else
  # NIP-11: the relay answers a plain GET with the relay information document
  # when Accept: application/nostr+json, BEFORE any community binding. It is the
  # cheapest proof that TLS terminated and the request reached buzz and not an
  # ALB 503 page.
  if NIP11="$(curl -sf --max-time 15 -H 'Accept: application/nostr+json' "$HTTPS_URL" 2>/dev/null)"; then
    pass "NIP-11 document served from ${HTTPS_URL}"
    printf '        %s\n' "$(printf '%s' "$NIP11" | head -c 200)"
  else
    fail "no NIP-11 response from ${HTTPS_URL}. Check: VPN connected? ALB target group healthy (health check must be :8080/_readiness, not / on :3000)? external-dns record present?"
  fi
fi

# ── 3. relay roster ─────────────────────────────────────────────────────────
step "3. relay membership roster (BUZZ_REQUIRE_RELAY_MEMBERSHIP=true)"
ROSTER_PUBKEYS=""
if [ -f "$ROSTER" ]; then
  ROSTER_PUBKEYS="$(grep -v '^[[:space:]]*#' "$ROSTER" | awk 'NF>=2 {print $2}')"
  printf '  roster file: %s (%s entries)\n' "$ROSTER" "$(printf '%s' "$ROSTER_PUBKEYS" | grep -c . || true)"
else
  printf '  roster file: %s (absent)\n' "$ROSTER"
fi

if [ "$SKIP_CLUSTER" = true ] || ! command -v kubectl >/dev/null 2>&1; then
  skip "roster check needs kubectl"
else
  if MEMBERS="$(kubectl -n "$NAMESPACE" exec "deploy/${RELEASE}" -- buzz-admin list-members 2>/dev/null)"; then
    pass "buzz-admin list-members reachable"
    if [ -n "$ROSTER_PUBKEYS" ]; then
      while read -r pk; do
        [ -n "$pk" ] || continue
        if printf '%s' "$MEMBERS" | grep -qi "$pk"; then
          pass "member present: ${pk:0:16}…"
        else
          # Roles are admin|member ONLY — `owner` comes from RELAY_OWNER_PUBKEY
          # config, and `bot` is a CHANNEL member role, not a relay one.
          fail "not a relay member: ${pk}
        add with: kubectl -n ${NAMESPACE} exec deploy/${RELEASE} -- buzz-admin add-member --pubkey ${pk} --role member"
        fi
      done <<< "$ROSTER_PUBKEYS"
    else
      skip "no roster file — cannot check individual members"
    fi
  else
    fail "buzz-admin list-members failed against deploy/${RELEASE} in ${NAMESPACE}"
  fi
fi

# ── invite minting (optional) ───────────────────────────────────────────────
if [ "$MINT_INVITE" = true ]; then
  step "3b. mint an invite code (POST /api/invites)"
  if [ -z "${BUZZ_OWNER_SECRET_KEY:-}" ]; then
    fail "--mint-invite needs BUZZ_OWNER_SECRET_KEY (the owner keypair from PREFLIGHT.md)"
  elif [ -z "${ARIA_FRONTEND_ROOT:-}" ]; then
    skip "minting requires a NIP-98 signer; the supported pilot path is the web invite flow at ${HTTPS_URL}"
  else
    # POST /api/invites is NIP-98-authenticated and callable by owner/admin only.
    # NIP-98 (kind 27235) is NOT part of the bridge's N3 client scope, so this is
    # best-effort: if the helper does not implement it, say so and move on.
    if python3 "${ARIA_FRONTEND_ROOT}/apps/bridge/local/smoke_mention.py" --mint-invite \
         --relay-url "$RELAY_URL" --secret-key-env BUZZ_OWNER_SECRET_KEY 2>/dev/null; then
      pass "invite minted"
    else
      skip "smoke_mention.py does not implement --mint-invite (NIP-98). Use the web invite flow: ${HTTPS_URL}"
    fi
  fi
fi

# ── 4/5/6. mention round-trip, burst, cross-mention matrix ──────────────────
CLIENT=""
if [ -n "${ARIA_FRONTEND_ROOT:-}" ]; then
  CLIENT="${ARIA_FRONTEND_ROOT}/apps/bridge/local/smoke_mention.py"
fi

run_mention() {
  # $1 agent pubkey, $2 message text, $3 burst count. Emits the helper's JSON.
  python3 "$CLIENT" \
    --relay-url "$RELAY_URL" \
    --secret-key-env BUZZ_SMOKE_SECRET_KEY \
    --channel "$CHANNEL" \
    --mention "$1" \
    --text "$2" \
    --burst "$3" \
    --timeout "$TIMEOUT" \
    --json
}

json_field() {
  # $1 json, $2 jq filter. jq is required for the round-trip steps because the
  # matrix logic reads a list of reply authors — that is not a job for grep.
  printf '%s' "$1" | jq -r "$2"
}

step "4. mention round-trip"
if [ -z "$CLIENT" ] || [ ! -f "$CLIENT" ]; then
  skip "no synthetic-human client. Set ARIA_FRONTEND_ROOT to the aria-frontend checkout (expects apps/bridge/local/smoke_mention.py — spec node N4). Steps 4-6 not run."
elif ! command -v python3 >/dev/null 2>&1; then
  skip "python3 not on PATH"
elif ! command -v jq >/dev/null 2>&1; then
  skip "jq not on PATH (needed to read the client's --json result)"
elif [ -z "${BUZZ_SMOKE_SECRET_KEY:-}" ]; then
  skip "BUZZ_SMOKE_SECRET_KEY unset — no synthetic human identity"
else
  # Build the agent list.
  AGENTS=""
  if [ "$TEAM" = true ]; then
    [ -f "$ROSTER" ] || die "--team needs a roster file; none at ${ROSTER}"
    AGENTS="$(grep -v '^[[:space:]]*#' "$ROSTER" | awk 'NF>=2 {print $1" "$2}')"
  elif [ -n "$AGENT" ]; then
    AGENTS="target ${AGENT}"
  elif [ -f "$ROSTER" ]; then
    AGENTS="$(grep -v '^[[:space:]]*#' "$ROSTER" | awk 'NF>=2 {print $1" "$2; exit}')"
  fi
  [ -n "$AGENTS" ] || die "no agent to mention: pass --agent <hex> or provide a roster"

  ALL_AGENT_KEYS="$(printf '%s\n' "$AGENTS" | awk '{print $2}')"

  while read -r slug pubkey; do
    [ -n "$pubkey" ] || continue
    printf '\n  -- agent %s (%s…)\n' "$slug" "${pubkey:0:16}"

    if ! RESULT="$(run_mention "$pubkey" "smoke @${slug}: what does the search_kb skill do?" 1 2>&1)"; then
      fail "${slug}: client exited non-zero — ${RESULT}"
      continue
    fi

    if [ "$(json_field "$RESULT" '.ok')" != "true" ]; then
      fail "${slug}: no threaded reply within ${TIMEOUT}s — $(json_field "$RESULT" '.error // "no error field"')"
      continue
    fi
    pass "${slug}: threaded kind:9 reply received"

    # Threading is the contract, not a nicety: without the root `e` tag the
    # desktop client renders the answer as a new top-level message and the
    # conversation mapping is invisible to the human.
    # `// []` / `// ""` throughout: a missing field must read as "absent" and
    # fail the assertion, not blow up jq and take the whole run to exit 2.
    [ "$(json_field "$RESULT" '.replies[0].tags_h // ""')" != "" ] \
      && pass "${slug}: reply carries the channel h tag" \
      || fail "${slug}: reply is missing its h tag"
    [ "$(json_field "$RESULT" '(.replies[0].tags_e // []) | length')" -gt 0 ] \
      && pass "${slug}: reply carries a root e tag" \
      || fail "${slug}: reply is missing the root e tag (not threaded)"
    [ "$(json_field "$RESULT" '(.replies[0].tags_p // []) | length')" -gt 0 ] \
      && pass "${slug}: reply p-tags the requester" \
      || fail "${slug}: reply does not p-tag the requester"

    # ── 6. cross-mention isolation ──
    if [ "$TEAM" = true ]; then
      AUTHORS="$(json_field "$RESULT" '[(.replies // [])[].pubkey] | unique | .[]')"
      STRAY=0
      while read -r author; do
        [ -n "$author" ] || continue
        if [ "$author" != "$pubkey" ] && printf '%s\n' "$ALL_AGENT_KEYS" | grep -qx "$author"; then
          fail "${slug}: agent ${author:0:16}… answered a mention addressed to ${slug}"
          STRAY=$((STRAY + 1))
        fi
      done <<< "$AUTHORS"
      [ "$STRAY" -eq 0 ] && pass "${slug}: no other agent answered (p-tag gate holds)"
    fi
  done <<< "$AGENTS"

  # ── 5. burst / rate limiter ──
  step "5. ${BURST}-message burst does not trip the rate limiter"
  # Standalone agents authenticate WITHOUT an agent_owner_pubkey, so the relay
  # meters them at the HUMAN tier: 60 messages/min, 10 WS events/s
  # (crates/buzz-relay/src/connection.rs:630-648). Decision O2 accepts that and
  # makes the bridge pace its replies. A burst of 10 must stay well inside it —
  # if this trips, the limiter is misconfigured, not the test.
  FIRST_AGENT="$(printf '%s\n' "$AGENTS" | awk '{print $2; exit}')"
  if BURST_RESULT="$(run_mention "$FIRST_AGENT" "smoke burst" "$BURST" 2>&1)"; then
    if [ "$(json_field "$BURST_RESULT" '.rate_limited')" = "true" ]; then
      fail "relay returned 'rate-limited: quota exceeded' inside a ${BURST}-message burst (human tier is 60/min — check BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN and Redis health; the limiter fails CLOSED on Redis errors)"
    else
      pass "no rate-limit rejection across ${BURST} messages"
    fi
  else
    fail "burst run failed: ${BURST_RESULT}"
  fi
fi

# ── verdict ─────────────────────────────────────────────────────────────────
printf '\n== result\n'
printf '  failures: %s   skipped: %s\n' "$FAILURES" "$SKIPPED"
if [ "$SKIPPED" -gt 0 ]; then
  printf '  NOTE: skipped checks are NOT passes. A green exit with skips does not\n'
  printf '        satisfy the phase-0 exit criteria — see SMOKE.md.\n'
fi
if [ "$FAILURES" -eq 0 ]; then
  printf '  SMOKE PASSED\n'
  printf '  Still required by hand: desktop client session + timestamped screenshot (SMOKE.md §4).\n'
  exit 0
fi
printf '  SMOKE FAILED\n'
exit 1
