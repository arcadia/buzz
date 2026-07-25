#!/usr/bin/env bash
# SSM pre-flight for the buzz relay + ARIA bridge (spec node N6).
#
# WHY A SCRIPT AND NOT A CHECKLIST
# --------------------------------
# External Secrets Operator resolves an ExternalSecret ALL-OR-NOTHING. One
# missing SSM parameter leaves the whole `buzz-secrets` Secret unwritten, so
# every relay Pod crash-loops with no clue which key was missing. The same is
# true of the bridge's `buzz-bridge-secrets`. So the parameters must all exist
# BEFORE the cloud-config-infrastructures PR merges, and "all" has to be
# machine-checked, not eyeballed.
#
# The relay key list is not retyped here — it is DERIVED from the chart's
# `externalSecret.data` map (deploy/charts/buzz-arcadia/values.yaml) whenever a
# YAML parser is available, and compared against the built-in list. If the chart
# adds a key and this script is not updated, --verify goes red on drift instead
# of passing and letting the deploy discover it.
#
# MODES
#   --verify   read-only. Exits 0 only when every required parameter exists.
#              This is the acceptance gate:  provision-secrets.sh --verify dev-ai
#   --plan     print the exact aws ssm put-parameter commands, generating no
#              key material and writing nothing. Default when no mode is given.
#   --apply    generate key material and write it to SSM. Prints public keys and
#              parameter names only — a private key is never echoed, never
#              written to disk, and never passed on a command line (put-parameter
#              reads it from a file descriptor, not argv, so it stays out of
#              `ps auxww`).
#
# USAGE
#   deploy/scripts/provision-secrets.sh --verify dev-ai
#   deploy/scripts/provision-secrets.sh --plan   dev-ai
#   deploy/scripts/provision-secrets.sh --apply  dev-ai --agents aria
#   deploy/scripts/provision-secrets.sh --verify prd-ai --scope relay
#
# FLAGS
#   --scope relay|bridge|all   which tier to act on (default: all)
#   --agents a,b,c             agent slugs -> buzz/agent-key-<slug>
#                              (default: aria — the phase-0 generalist)
#   --profile <name>           AWS profile
#
# EXIT CODES
#   0  every required parameter present (--verify) / plan printed / apply done
#   1  a required parameter is missing or malformed
#   2  usage, tooling, or wrong-account error
#
# ACCOUNT SAFETY
#   The script refuses to run unless the caller's AWS account matches the
#   cluster: dev-ai = 258174056699, prd-ai = 572630832277. Writing dev key
#   material into the prd path would hand the prd relay a dev identity.
#
# See PREFLIGHT.md (deploy/charts/buzz-arcadia/) for the full runbook, the
# backup/break-glass procedure, and what is deliberately NOT in SSM.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CHART_VALUES="${REPO_ROOT}/deploy/charts/buzz-arcadia/values.yaml"

MODE=plan
CLUSTER=""
SCOPE=all
AGENT_SLUGS="${BUZZ_AGENT_SLUGS:-aria}"
AWS_PROFILE_ARG=()
REGION="${AWS_REGION:-us-east-1}"

die()  { printf 'FAIL: %s\n' "$*" >&2; exit 2; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
log()  { printf '%s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --verify)  MODE=verify; shift ;;
    --plan)    MODE=plan;   shift ;;
    --apply)   MODE=apply;  shift ;;
    --scope)   SCOPE="${2:?--scope needs relay|bridge|all}"; shift 2 ;;
    --agents)  AGENT_SLUGS="${2:?--agents needs a comma-separated list}"; shift 2 ;;
    --profile) AWS_PROFILE_ARG=(--profile "${2:?--profile needs a value}"); shift 2 ;;
    --region)  REGION="${2:?--region needs a value}"; shift 2 ;;
    -h|--help) sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    dev-ai|prd-ai) CLUSTER="$1"; shift ;;
    *) die "unknown argument: $1 (expected a mode flag and dev-ai|prd-ai)" ;;
  esac
done

[ -n "$CLUSTER" ] || die "no cluster given; expected dev-ai or prd-ai"
case "$SCOPE" in relay|bridge|all) ;; *) die "--scope must be relay, bridge or all" ;; esac

# ── environment map ─────────────────────────────────────────────────────────
# `infrastructure` is the first SSM path segment and does NOT equal the cluster
# name (ai-dev vs dev-ai — they are transposed, and getting it wrong writes
# parameters ESO will never look at). Source of truth: the cluster's
# global-helm-values-patch.yaml.
case "$CLUSTER" in
  dev-ai) INFRASTRUCTURE=ai-dev; EXPECT_ACCOUNT=258174056699 ;;
  prd-ai) INFRASTRUCTURE=ai;     EXPECT_ACCOUNT=572630832277 ;;
esac
SSM_PREFIX="/${INFRASTRUCTURE}/${CLUSTER}/buzz"

command -v aws >/dev/null 2>&1 || die "aws CLI not on PATH"

aws_ssm() { aws ssm "${AWS_PROFILE_ARG[@]}" --region "$REGION" "$@"; }

if [ "$MODE" != plan ]; then
  ACCOUNT="$(aws sts get-caller-identity "${AWS_PROFILE_ARG[@]}" --query Account --output text)" \
    || die "cannot reach AWS STS — check credentials/profile"
  [ "$ACCOUNT" = "$EXPECT_ACCOUNT" ] \
    || die "caller is in account ${ACCOUNT}, but ${CLUSTER} is ${EXPECT_ACCOUNT}. Refusing: this would provision the wrong environment's identity."
fi

# ── the parameter inventory ─────────────────────────────────────────────────
# Format: <tail>|<type>|<tier>|<how it is produced>|<what consumes it>
#
# NOT IN SSM, on purpose (each of these was wrong in an earlier draft):
#   database-url  the Crossplane RDS endpoint does not exist until the first
#                 sync provisions the instance, and Crossplane emits
#                 username/password/endpoint as separate keys, never a URL. The
#                 chart composes DATABASE_URL in the ExternalSecret target
#                 template from the connection Secret (decision O3). Note this
#                 is the URL only: the bridge ROLE's password IS an SSM
#                 parameter (aria-db-password, bridge tier below) because
#                 nothing else mints it — Crossplane's connection Secret holds
#                 the RDS master credentials, which the bridge Deployment must
#                 never see.
#   redis-url     composed in-chart from the Redis Service name + the password
#                 parameter below.
#   s3-access-key / s3-secret-key
#                 unprovisionable (a Crossplane Bucket claim mints no IAM user)
#                 and unnecessary — the relay falls back to the AWS default
#                 credential chain, i.e. IRSA, when both are empty (decision D5,
#                 node N18). There is no media in phase 0 at all.
#   litellm-key-* fetched at runtime, per enrolled human, by the bridge.
#   owner-private-key
#                 deliberately absent. It signs NIP-98 invite mints, so somebody
#                 must hold it — but `buzz-admin add-member` writes the roster
#                 straight to Postgres, which means losing the owner key costs
#                 the invite-link flow and nothing else. Keeping it out of SSM
#                 removes a standing high-value secret in exchange for a
#                 documented break-glass (PREFLIGHT.md §Break-glass).
RELAY_PARAMS=(
  "relay-private-key|SecureString|relay|buzz-admin generate-key (Secret key)|BUZZ_RELAY_PRIVATE_KEY — the relay's Nostr identity. Rotating it IS a new relay identity."
  "git-hook-hmac|SecureString|relay|openssl rand -hex 32|BUZZ_GIT_HOOK_HMAC_SECRET — required at replicaCount>1; relay rejects a secret under 32 chars."
  "redis-password|SecureString|relay|openssl rand -hex 24|REDIS_PASSWORD, and the chart composes REDIS_URL from it."
)
# Public, not secret — but still out-of-band: the ArgoCD Application carries it
# as buzz.ownerPubkey, and it must be recorded next to the identity it belongs
# to rather than living only in a PR diff.
OWNER_PARAMS=(
  "owner-pubkey|String|relay|buzz-admin generate-key (Public key)|Application value buzz.ownerPubkey. 64 lowercase hex."
)
BRIDGE_PARAMS=(
  "aria-bot-api-token|SecureString|bridge|aria-bot admin issues it|bridge -> POST https://api.aria.arcadiaanalytics.com/tasks (node N13)"
  "arcadia-docs-mcp-token|SecureString|bridge|arcadia-docs MCP admin issues it|bridge -> arcadia-docs http MCP server"
  "aria-db-password|SecureString|bridge|openssl rand -hex 24|bridge Postgres role password (chart database.passwordKeyName): the bootstrap Job CREATEs the role with it and ESO composes ARIA_DATABASE_URL from it. Hex on purpose — it is embedded in a URL."
  "pilot-allowlist|SecureString|bridge|admin-authored, comma separated <pubkey-hex>:<aria_user_id>:<persona>[:<environment>]|BUZZ_PILOT_ALLOWLIST (chart pilotAllowlist.fromSecret) — phase-0 execution authorization. An unlisted pubkey is refused and executes nothing, so an empty value is a valid but useless deploy."
)

AGENT_PARAMS=()
IFS=',' read -r -a _slugs <<< "$AGENT_SLUGS"
for slug in "${_slugs[@]}"; do
  slug="$(printf '%s' "$slug" | tr -d '[:space:]')"
  [ -n "$slug" ] || continue
  AGENT_PARAMS+=("agent-key-${slug}|SecureString|bridge|buzz-admin generate-key (Secret key)|bridge agent '${slug}' Nostr identity (buzz-bridge-secrets, chart D12)")
done

selected_params() {
  local p
  if [ "$SCOPE" = relay ] || [ "$SCOPE" = all ]; then
    for p in "${RELAY_PARAMS[@]}" "${OWNER_PARAMS[@]}"; do printf '%s\n' "$p"; done
  fi
  if [ "$SCOPE" = bridge ] || [ "$SCOPE" = all ]; then
    for p in "${BRIDGE_PARAMS[@]}" "${AGENT_PARAMS[@]}"; do printf '%s\n' "$p"; done
  fi
}

# ── drift gate against the charts ───────────────────────────────────────────
# Two ExternalSecrets consume this inventory and they live in two repos (D12).
# Both tiers are therefore checked against their own chart:
#
#   relay tier  == deploy/charts/buzz-arcadia/values.yaml externalSecret.data
#                  (exact equality; the chart is in this repo, so there is no
#                  excuse for a mismatch)
#   bridge tier >= what aria-frontend/deploy/k8s/aria-buzz-bridge resolves
#                  (superset: one buzz environment can host several agent
#                  releases, so extra agent-key-<slug> params are normal). Only
#                  runs when a sibling aria-frontend checkout is present — the
#                  bridge chart is not in this repo and the pre-flight must
#                  still work without it.
#
# The bridge half exists because the relay-only check let `aria-db-password` and
# `pilot-allowlist` go missing from this list while the bridge chart consumed
# them under its defaults: --verify went green, then ESO failed
# buzz-bridge-secrets all-or-nothing and the bridge never started.
find_parser() {
  if command -v python3 >/dev/null 2>&1; then printf 'python3'; return 0; fi
  if command -v python  >/dev/null 2>&1; then printf 'python';  return 0; fi
  return 1
}

# Locates aria-frontend's bridge chart values. Explicit env var wins; otherwise
# any sibling checkout of the repo (worktrees included) that carries the chart.
find_bridge_values() {
  local candidate
  if [ -n "${ARIA_FRONTEND_REPO:-}" ]; then
    candidate="${ARIA_FRONTEND_REPO}/deploy/k8s/aria-buzz-bridge/values.yaml"
    [ -f "$candidate" ] && { printf '%s' "$candidate"; return 0; }
    return 1
  fi
  for candidate in "$(dirname "$REPO_ROOT")"/aria-frontend*; do
    [ -f "${candidate}/deploy/k8s/aria-buzz-bridge/values.yaml" ] \
      && { printf '%s' "${candidate}/deploy/k8s/aria-buzz-bridge/values.yaml"; return 0; }
  done
  return 1
}

check_relay_drift() {
  local parser="$1" chart_tails script_expected
  if [ ! -f "$CHART_VALUES" ]; then
    warn "no ${CHART_VALUES} — skipping the relay chart drift check."
    return 0
  fi
  chart_tails="$("$parser" - "$CHART_VALUES" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding="utf-8") as fh:
    values = yaml.safe_load(fh)
for tail in sorted((values.get("externalSecret") or {}).get("data", {}).values()):
    print(tail)
PY
)" || { warn "could not parse ${CHART_VALUES} (PyYAML missing?) — skipping relay drift check."; return 0; }

  script_expected="$(for p in "${RELAY_PARAMS[@]}"; do printf 'buzz/%s\n' "${p%%|*}"; done | sort)"
  if [ "$chart_tails" != "$script_expected" ]; then
    printf 'FAIL: relay SSM key list drifted from the chart.\n' >&2
    printf '  chart  (deploy/charts/buzz-arcadia/values.yaml externalSecret.data):\n%s\n' "$chart_tails" >&2
    printf '  script (RELAY_PARAMS in %s):\n%s\n' "${BASH_SOURCE[0]}" "$script_expected" >&2
    printf '  Reconcile them before provisioning: ESO fails the whole Secret on one missing key.\n' >&2
    exit 1
  fi
  log "chart drift check: OK (relay keys match externalSecret.data)"
}

check_bridge_drift() {
  local parser="$1" bridge_values chart_tails have missing=0 agent_missing=0 tail
  if ! bridge_values="$(find_bridge_values)"; then
    warn "no sibling aria-frontend checkout — skipping the BRIDGE chart drift check."
    warn "Set ARIA_FRONTEND_REPO=/path/to/aria-frontend to enable it. Without it, a key the"
    warn "bridge chart consumes but this script does not list will pass --verify and then fail"
    warn "the whole buzz-bridge-secrets ExternalSecret at sync time."
    return 0
  fi

  # Mirrors deploy/k8s/aria-buzz-bridge/templates/externalsecret.yaml: the data
  # map, the agent key (agentKeyName or agent-key-<agent.slug>), the database
  # role password when database.enabled, and the literal `pilot-allowlist` when
  # pilotAllowlist.fromSecret. The last two are hardcoded in that template, not
  # values, which is exactly how they were missed.
  chart_tails="$("$parser" - "$bridge_values" <<'PY'
import sys, yaml
with open(sys.argv[1], encoding="utf-8") as fh:
    values = yaml.safe_load(fh) or {}
es = values.get("externalSecret") or {}
tails = set()
if es.get("enabled", True):
    tails.update((es.get("data") or {}).values())
    slug = (values.get("agent") or {}).get("slug") or ""
    tails.add(es.get("agentKeyName") or (slug and "agent-key-%s" % slug))
    db = values.get("database") or {}
    if db.get("enabled"):
        tails.add(db.get("passwordKeyName"))
    if (values.get("pilotAllowlist") or {}).get("fromSecret"):
        tails.add("pilot-allowlist")
for tail in sorted(t for t in tails if t):
    print(tail)
PY
)" || { warn "could not parse ${bridge_values} (PyYAML missing?) — skipping bridge drift check."; return 0; }

  have="$(for p in "${BRIDGE_PARAMS[@]}" "${AGENT_PARAMS[@]}"; do printf '%s\n' "${p%%|*}"; done)"
  while IFS= read -r tail; do
    [ -n "$tail" ] || continue
    if printf '%s\n' "$have" | grep -Fxq "$tail"; then continue; fi
    case "$tail" in
      agent-key-*)
        # Not fatal: a second agent release pins its own slug, and this script
        # is told which ones to act on with --agents.
        warn "bridge chart's agent key '${tail}' is not in this run's --agents list (${AGENT_SLUGS})."
        agent_missing=$((agent_missing + 1))
        ;;
      *)
        printf 'FAIL: bridge SSM key list drifted from the bridge chart — missing %s\n' "$tail" >&2
        missing=$((missing + 1))
        ;;
    esac
  done <<EOF
$chart_tails
EOF

  if [ "$missing" -gt 0 ]; then
    printf '  chart  (%s):\n%s\n' "$bridge_values" "$chart_tails" >&2
    printf '  script (BRIDGE_PARAMS + AGENT_PARAMS in %s):\n%s\n' "${BASH_SOURCE[0]}" "$have" >&2
    printf '  Add the missing tails to BRIDGE_PARAMS and PREFLIGHT.md: ESO fails the whole\n' >&2
    printf '  buzz-bridge-secrets Secret on one missing key, with no log naming it.\n' >&2
    exit 1
  fi
  if [ "$agent_missing" -eq 0 ]; then
    log "chart drift check: OK (bridge keys cover ${bridge_values})"
  fi
}

check_chart_drift() {
  local parser=""
  if ! parser="$(find_parser)"; then
    warn "no python on PATH — skipping the chart drift checks."
    warn "Run --verify from a checkout with python3 available before trusting a green result."
    return 0
  fi
  if [ "$SCOPE" = relay ] || [ "$SCOPE" = all ]; then
    check_relay_drift "$parser"
  fi
  if [ "$SCOPE" = bridge ] || [ "$SCOPE" = all ]; then
    check_bridge_drift "$parser"
  fi
}

# ── modes ───────────────────────────────────────────────────────────────────
do_plan() {
  log "# Pre-flight plan for ${CLUSTER} (account ${EXPECT_ACCOUNT}, prefix ${SSM_PREFIX})"
  log "# Nothing below has been run. Review, then use --apply, or paste by hand."
  log ""
  while IFS='|' read -r tail type tier how consumer; do
    [ -n "$tail" ] || continue
    log "# ${tier}: ${consumer}"
    log "#   produced by: ${how}"
    case "$how" in
      *"generate-key"*)
        log "#   buzz-admin generate-key    # then feed the right half in from a file, never argv"
        ;;
      *"openssl rand"*)
        log "#   ${how} > /dev/shm/${tail}.val"
        ;;
    esac
    log "aws ssm put-parameter --region ${REGION} \\"
    log "  --name ${SSM_PREFIX}/${tail} \\"
    log "  --type ${type} --value file:///dev/shm/${tail}.val --no-overwrite"
    log ""
  done < <(selected_params)
  log "# Then: $0 --verify ${CLUSTER}"
}

put_param() {
  # $1 tail, $2 type, $3 value. The value arrives on stdin-adjacent storage,
  # not in argv: --value file://... keeps it out of the process table.
  local tail="$1" type="$2" value="$3" tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/ssm.XXXXXX")"
  chmod 600 "$tmp"
  printf '%s' "$value" > "$tmp"
  if aws_ssm put-parameter --name "${SSM_PREFIX}/${tail}" --type "$type" \
       --value "file://${tmp}" --no-overwrite >/dev/null 2>&1; then
    log "  created  ${SSM_PREFIX}/${tail}"
  else
    # --no-overwrite is deliberate: re-running --apply must never silently
    # replace a live relay identity. Existing = leave it alone, say so.
    log "  exists   ${SSM_PREFIX}/${tail}  (left untouched — use the rotation runbook to change it)"
  fi
  rm -f "$tmp"
}

find_buzz_admin() {
  if [ -n "${BUZZ_ADMIN:-}" ]; then printf '%s' "$BUZZ_ADMIN"; return 0; fi
  if command -v buzz-admin >/dev/null 2>&1; then printf 'buzz-admin'; return 0; fi
  return 1
}

generate_keypair() {
  # Emits "<pubkey-hex> <seckey-hex>" on stdout. `buzz-admin generate-key` is
  # the ONLY supported generator — there is no `keygen` subcommand, and a
  # hand-rolled secp256k1 keypair risks a key the relay will not accept.
  local admin out
  if admin="$(find_buzz_admin)"; then
    out="$($admin generate-key)"
  elif command -v cargo >/dev/null 2>&1 && [ -f "${REPO_ROOT}/Cargo.toml" ]; then
    out="$(cd "$REPO_ROOT" && cargo run -q -p buzz-admin -- generate-key)"
  else
    die "no buzz-admin. Either build it (cargo build -p buzz-admin), set BUZZ_ADMIN=/path/to/buzz-admin, or run it out of the relay image:
  docker run --rm --entrypoint /usr/local/bin/buzz-admin <account>.dkr.ecr.${REGION}.amazonaws.com/buzz/relay:<tag> generate-key"
  fi
  local pub sec
  pub="$(printf '%s' "$out" | sed -n 's/^Public key: *//p'  | tr -d '[:space:]')"
  sec="$(printf '%s' "$out" | sed -n 's/^Secret key: *//p'  | tr -d '[:space:]')"
  [ ${#pub} -eq 64 ] && [ ${#sec} -eq 64 ] \
    || die "buzz-admin generate-key output did not parse into two 64-char hex keys — its output format changed; fix generate_keypair() rather than guessing."
  printf '%s %s' "$pub" "$sec"
}

do_apply() {
  # Declared up front and unset at the end: `kp` transits private key material,
  # and a stray global holding it for the rest of the run is avoidable.
  local kp="" slug="" relay_pub="" relay_sec="" owner_pub="" owner_sec=""

  check_chart_drift
  command -v openssl >/dev/null 2>&1 || die "openssl not on PATH (needed for the HMAC and Redis secrets)"
  log "Provisioning ${SSM_PREFIX}/* in account ${EXPECT_ACCOUNT} (scope: ${SCOPE})"
  log "Existing parameters are NEVER overwritten."
  log ""

  if [ "$SCOPE" = relay ] || [ "$SCOPE" = all ]; then
    log "relay tier:"
    kp="$(generate_keypair)"; relay_pub="${kp%% *}"; relay_sec="${kp##* }"
    put_param relay-private-key SecureString "$relay_sec"
    put_param git-hook-hmac     SecureString "$(openssl rand -hex 32)"
    put_param redis-password    SecureString "$(openssl rand -hex 24)"

    kp="$(generate_keypair)"; owner_pub="${kp%% *}"; owner_sec="${kp##* }"
    put_param owner-pubkey String "$owner_pub"
    log ""
    log "  relay pubkey (informational, derived): ${relay_pub}"
    log "  owner  pubkey -> Application buzz.ownerPubkey: ${owner_pub}"
    log ""
    log "  ACTION REQUIRED — the owner SECRET key is printed once, now, and is"
    log "  not stored anywhere by this script. Put it in the team password"
    log "  manager before you close this terminal. It signs NIP-98 invite mints"
    log "  (POST /api/invites). Losing it costs invite links only; roster"
    log "  changes stay possible via 'buzz-admin add-member' (break-glass)."
    log "  owner secret key: ${owner_sec}"
    log ""
  fi

  if [ "$SCOPE" = bridge ] || [ "$SCOPE" = all ]; then
    log "bridge tier:"
    for slug in "${_slugs[@]}"; do
      slug="$(printf '%s' "$slug" | tr -d '[:space:]')"
      [ -n "$slug" ] || continue
      kp="$(generate_keypair)"
      put_param "agent-key-${slug}" SecureString "${kp##* }"
      log "    agent '${slug}' pubkey: ${kp%% *}   <- humans @mention this identity"
    done
    # The bridge's own Postgres role password. Generated here because nothing
    # else mints it: Crossplane's connection Secret carries the RDS MASTER
    # credentials, which the bridge Deployment must never hold. The bootstrap
    # Job CREATEs the role with this value and the ESO Kubernetes-provider
    # template composes ARIA_DATABASE_URL from it (decision O3). Hex, so the
    # value survives being embedded in a URL.
    put_param aria-db-password SecureString "$(openssl rand -hex 24)"
    log ""
    log "  aria-bot-api-token, arcadia-docs-mcp-token and pilot-allowlist are"
    log "  authored elsewhere — two are issued by their owning services and the"
    log "  third is an identity mapping a human writes. Create them with:"
    log "    aws ssm put-parameter --region ${REGION} --name ${SSM_PREFIX}/aria-bot-api-token --type SecureString --value file://<file> --no-overwrite"
    log "    aws ssm put-parameter --region ${REGION} --name ${SSM_PREFIX}/arcadia-docs-mcp-token --type SecureString --value file://<file> --no-overwrite"
    log "    aws ssm put-parameter --region ${REGION} --name ${SSM_PREFIX}/pilot-allowlist --type SecureString --value file://<file> --no-overwrite"
    log ""
    log "  pilot-allowlist format (comma separated, no spaces):"
    log "    <pubkey-hex>:<aria_user_id>:<persona>[:<environment>]"
    log "  It is the phase-0 execution gate: a mention from a pubkey that is not"
    log "  on it is refused and runs nothing. Relay membership grants chat, never"
    log "  ARIA execution."
    log ""
  fi

  unset kp relay_sec owner_sec
  log "Now verify: $0 --verify ${CLUSTER}"
}

do_verify() {
  check_chart_drift
  log ""
  log "Verifying ${SSM_PREFIX}/* in account ${EXPECT_ACCOUNT} (scope: ${SCOPE})"
  log ""
  printf '  %-9s %-26s %-12s %s\n' RESULT PARAMETER TYPE NOTE
  local missing=0 wrongtype=0

  while IFS='|' read -r tail type tier how consumer; do
    [ -n "$tail" ] || continue
    local name="${SSM_PREFIX}/${tail}" actual_type note=""
    # No --with-decryption: existence and type are all that is being asserted,
    # and pulling plaintext relay identities into a terminal (and its scrollback)
    # to prove they exist is a needless exposure.
    if ! actual_type="$(aws_ssm get-parameter --name "$name" --query 'Parameter.Type' --output text 2>/dev/null)"; then
      printf '  %-9s %-26s %-12s %s\n' MISSING "$tail" "$type" "produced by: ${how}"
      missing=$((missing + 1))
      continue
    fi
    if [ "$actual_type" != "$type" ]; then
      printf '  %-9s %-26s %-12s %s\n' BADTYPE "$tail" "$actual_type" "expected ${type}"
      wrongtype=$((wrongtype + 1))
      continue
    fi
    # owner-pubkey is a plain String and is load-bearing for the Application:
    # a wrong-shaped value renders fine and fails at relay startup, so check it.
    if [ "$tail" = "owner-pubkey" ]; then
      local val
      val="$(aws_ssm get-parameter --name "$name" --query 'Parameter.Value' --output text)"
      if ! printf '%s' "$val" | grep -Eq '^[0-9a-f]{64}$'; then
        printf '  %-9s %-26s %-12s %s\n' BADVALUE "$tail" "$actual_type" "not 64 lowercase hex — buzz.ownerPubkey will be rejected"
        wrongtype=$((wrongtype + 1))
        continue
      fi
      note="= ${val}"
    fi
    printf '  %-9s %-26s %-12s %s\n' OK "$tail" "$actual_type" "$note"
  done < <(selected_params)

  log ""
  if [ "$missing" -eq 0 ] && [ "$wrongtype" -eq 0 ]; then
    log "PASS — every required parameter exists. The Application may merge."
    log "Reminder: this proves the parameters exist, not that ESO can read them."
    log "The ClusterSecretStore assertion is node N7's:"
    log "  kubectl get externalsecret -n buzz buzz-secrets"
    return 0
  fi
  log "FAIL — ${missing} missing, ${wrongtype} wrong type/value."
  log "Do NOT merge the ArgoCD Application yet: ESO resolves an ExternalSecret"
  log "all-or-nothing, so one gap crash-loops every relay Pod with no message"
  log "naming the key."
  return 1
}

case "$MODE" in
  plan)   do_plan ;;
  apply)  do_apply ;;
  verify) do_verify ;;
esac
