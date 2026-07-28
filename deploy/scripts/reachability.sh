#!/usr/bin/env bash
# Egress reachability probes for the ARIA x buzz bridge (spec node N0a).
#
# WHY THIS EXISTS, AHEAD OF ANY BRIDGE CODE
# -----------------------------------------
# The bridge (aria-frontend/apps/bridge) runs in the `buzz` namespace and has
# exactly two egress dependencies outside its own namespace:
#
#   1. aria-bot's task API   https://api.aria.arcadiaanalytics.com/health
#      From dev-ai this is a CROSS-ACCOUNT, off-cluster call (aria-bot runs on
#      ECS in a different account). Nothing on dev-ai has ever made it.
#   2. the in-cluster LiteLLM gateway
#      http://module-litellm-internal-proxy.litellm-internal.svc.cluster.local:4000/health
#      Same cluster, different namespace — subject to any NetworkPolicy that
#      namespace enforces.
#
# If (1) needs VPC peering or a transit-gateway route, that is multi-week SRE
# work (risk R3). Finding out during N13 would stall the long-task lane after
# every other node has landed. So this probe runs in phase 0, before the bridge
# exists, and its archived output is the evidence.
#
# A FAILURE HERE IS INFORMATION, NOT A BUG. Record the output either way.
#
# USAGE
# -----
# In-pod (the primary mode — this is what the AC means by "exits 0 from a
# dev-ai pod"). Requires only curl, which the relay image already carries:
#
#   deploy/scripts/reachability.sh                     # env auto-detected
#   deploy/scripts/reachability.sh --env dev-ai
#   deploy/scripts/reachability.sh --env prd-ai
#
# From a workstation, launching a throwaway probe pod (needs kubectl WRITE on
# the target cluster — that is why it is opt-in, never the default):
#
#   deploy/scripts/reachability.sh --launch --env dev-ai
#
# Other flags:
#   --timeout <secs>   per-request timeout (default 10)
#   --json             emit a machine-readable result line per target
#   --output <file>    tee the human transcript to a file for the runbook
#
# EXIT CODES
#   0  every required target reachable
#   1  at least one required target unreachable  (-> raise an SRE ticket)
#   2  usage / environment error
#
# ARCHIVING (change-control requires it)
#   deploy/scripts/reachability.sh --env dev-ai --output reachability-dev-ai-$(date -u +%Y%m%dT%H%M%SZ).txt
#   and attach the file to the AIFM ticket. PREFLIGHT.md links this step.

set -euo pipefail

# ── configuration ───────────────────────────────────────────────────────────
ENVIRONMENT="${BUZZ_ENV:-}"
TIMEOUT="${PROBE_TIMEOUT:-10}"
LAUNCH=false
JSON=false
OUTPUT=""
NAMESPACE="${NAMESPACE:-buzz}"
# Image for --launch. The relay image already contains curl and lives in the
# cluster's own ECR, so a probe pod needs no new mirror and no internet.
PROBE_IMAGE="${PROBE_IMAGE:-}"

# aria-bot's FastAPI task service. /health is explicitly unauthenticated
# (aria-bot/aria_bot/api/routes.py: "No auth required"), so a 200 here is a
# clean reachability signal with no credential in the probe.
ARIA_BOT_URL="${ARIA_BOT_URL:-https://api.aria.arcadiaanalytics.com/health}"
# The in-cluster LiteLLM gateway the bridge points ANTHROPIC_BASE_URL at.
LITELLM_URL="${LITELLM_URL:-http://module-litellm-internal-proxy.litellm-internal.svc.cluster.local:4000/health}"

usage() { sed -n '2,52p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --env)     ENVIRONMENT="${2:?--env needs a value}"; shift 2 ;;
    --timeout) TIMEOUT="${2:?--timeout needs a value}"; shift 2 ;;
    --output)  OUTPUT="${2:?--output needs a value}"; shift 2 ;;
    --launch)  LAUNCH=true; shift ;;
    --json)    JSON=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

log()  { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

if [ -n "$OUTPUT" ]; then
  exec > >(tee "$OUTPUT") 2>&1
fi

# ── --launch: run this same script inside a throwaway pod ───────────────────
if [ "$LAUNCH" = true ]; then
  command -v kubectl >/dev/null 2>&1 || { warn "--launch needs kubectl on PATH"; exit 2; }
  [ -n "$ENVIRONMENT" ] || { warn "--launch needs --env dev-ai|prd-ai"; exit 2; }
  if [ -z "$PROBE_IMAGE" ]; then
    warn "Set PROBE_IMAGE to the relay image in this cluster's ECR, e.g."
    warn "  PROBE_IMAGE=258174056699.dkr.ecr.us-east-1.amazonaws.com/buzz/relay:main-<sha>"
    warn "The clusters have no internet egress, so a docker.io probe image will"
    warn "ImagePullBackOff and look like a network failure it is not."
    exit 2
  fi
  POD="reachability-$(date -u +%s)"
  warn "Launching ${POD} in namespace ${NAMESPACE} (this is a kubectl WRITE)."
  # --command overrides the relay entrypoint; the pod exits when curl is done.
  kubectl -n "$NAMESPACE" run "$POD" \
    --image="$PROBE_IMAGE" --restart=Never --rm -i --quiet \
    --command -- /bin/sh -c "
      set -e
      probe() {
        code=\$(curl -sS -o /dev/null -w '%{http_code}' --max-time ${TIMEOUT} \"\$2\" 2>&1) \
          && echo \"PASS \$1 \$2 http=\${code}\" \
          || echo \"FAIL \$1 \$2\"
      }
      probe aria-bot '${ARIA_BOT_URL}'
      probe litellm  '${LITELLM_URL}'
    "
  exit $?
fi

# ── in-pod mode ─────────────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || { warn "curl not found — run this inside the relay image, which ships curl"; exit 2; }

if [ -z "$ENVIRONMENT" ]; then
  # Best-effort: the chart injects neither, so this is only a label for the
  # transcript. Unknown is fine; the targets do not depend on it.
  ENVIRONMENT="${CLUSTER_NAME:-unknown}"
fi

log "buzz bridge egress reachability — node N0a"
log "  environment : ${ENVIRONMENT}"
log "  timestamp   : $(date -u +%Y-%m-%dT%H:%M:%SZ)"
log "  pod         : ${HOSTNAME:-unknown}"
log "  timeout     : ${TIMEOUT}s"
log ""

FAILURES=0

probe() {
  local name="$1" url="$2" note="$3"
  local start end ms code result

  start="$(date +%s%N 2>/dev/null || echo 0)"
  # -o /dev/null: a health body may carry version detail we have no need to
  # archive. We want the code, the latency, and whether TLS completed.
  if code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time "$TIMEOUT" "$url" 2>/tmp/probe-err.$$)"; then
    end="$(date +%s%N 2>/dev/null || echo 0)"
    ms=$(( (end - start) / 1000000 ))
    if [ "$code" -ge 200 ] && [ "$code" -lt 400 ]; then
      result=PASS
    else
      # Reached it, but it answered badly. Still proves the NETWORK path, which
      # is what this node is about — call it out separately so an SRE ticket
      # does not get raised for an application-level 503.
      result=REACHABLE_BUT_UNHEALTHY
    fi
  else
    end="$(date +%s%N 2>/dev/null || echo 0)"
    ms=$(( (end - start) / 1000000 ))
    code=000
    result=FAIL
  fi
  rm -f "/tmp/probe-err.$$"

  if [ "$JSON" = true ]; then
    printf '{"target":"%s","url":"%s","result":"%s","http_code":"%s","latency_ms":%s}\n' \
      "$name" "$url" "$result" "$code" "$ms"
  else
    printf '  %-22s %-26s http=%-3s %5sms  %s\n' "$result" "$name" "$code" "$ms" "$url"
    [ -n "$note" ] && [ "$result" = FAIL ] && printf '      -> %s\n' "$note"
  fi

  [ "$result" = FAIL ] && FAILURES=$((FAILURES + 1))
  return 0
}

probe "aria-bot-tasks" "$ARIA_BOT_URL" \
  "No route from this cluster to aria-bot. This blocks node N13 (long-task dispatch) and needs VPC peering or a transit-gateway route — SRE ticket, multi-week lead time (risk R3). Everything else in phase 0 still works; interactive turns do not use this path."

probe "litellm-internal" "$LITELLM_URL" \
  "The in-cluster LiteLLM gateway is unreachable from namespace ${NAMESPACE}. Check the litellm-internal NetworkPolicy and that the Service name is still module-litellm-internal-proxy. This blocks EVERY bridge turn — it is ANTHROPIC_BASE_URL."

log ""
if [ "$FAILURES" -eq 0 ]; then
  log "RESULT: all targets reachable from ${ENVIRONMENT}."
  log "Archive this transcript on the AIFM ticket (change-control evidence)."
  exit 0
fi

log "RESULT: ${FAILURES} target(s) unreachable from ${ENVIRONMENT}."
log "Archive this transcript AND raise the SRE ticket named in the note above."
exit 1
