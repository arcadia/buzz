#!/usr/bin/env bash
# WebSocket soak evidence collector for the buzz relay (spec node N8).
#
# WHY THIS EXISTS RATHER THAN A DASHBOARD
# ---------------------------------------
# Risk R2 says WebSockets through an internal ALB are unproven on dev-ai and
# prd-ai — there is no precedent on either cluster. The phase-0 exit criteria
# therefore want a 24-hour soak CSV showing zero unexplained WS drops.
#
# The obvious way to get that is Prometheus. There is none: these clusters run
# grafana-stack/mimir/loki/alloy and have NO Prometheus Operator, so no
# ServiceMonitor or PodMonitor CRD exists (modules/observability/README.md).
# Scraping is Alloy River config in cloud-config-templates — a platform-infra
# change with a mandatory SRE ticket (node N14). Putting that on the phase-0
# critical path would gate the spike on someone else's queue.
#
# So: scrape :9102/metrics on a timer, append a CSV row per Pod per tick, and
# get the R2 evidence with zero platform dependencies. N14 still happens; this
# just is not blocked on it.
#
# HOW IT SCRAPES
# --------------
# Default is the API-server Pod proxy:
#   kubectl get --raw /api/v1/namespaces/<ns>/pods/<pod>:9102/proxy/metrics
# That is a pure READ through the API server — no exec into the Pod, no tooling
# required inside the container, and it works from anywhere kubectl works.
# `--via exec` falls back to `kubectl exec … curl` if the proxy subresource is
# blocked by policy (the relay image does ship curl).
#
# USAGE
#   deploy/scripts/soak-metrics.sh -n buzz -o soak.csv
#   deploy/scripts/soak-metrics.sh -n buzz -o soak.csv --interval 60 --duration 24h
#   deploy/scripts/soak-metrics.sh -n buzz -o soak.csv --once           # one tick
#   deploy/scripts/soak-metrics.sh --summary soak.csv                   # analyse
#
# Run it detached for a real soak:
#   nohup deploy/scripts/soak-metrics.sh -n buzz -o soak.csv --duration 24h &
#
# FLAGS
#   -n, --namespace <ns>   default: buzz
#   -o, --output <file>    CSV path (appends; header written once)
#   --interval <secs>      default: 60
#   --duration <spec>      30m | 12h | 86400 ; default: 24h. 0 = forever.
#   --selector <sel>       default: app.kubernetes.io/name=buzz
#   --via proxy|exec       default: proxy
#   --once                 single tick, then exit
#   --summary <file>       print the soak verdict for an existing CSV and exit
#
# EXIT CODES
#   0  collection finished (or --summary found no unexplained drops)
#   1  --summary found unexplained WS drops
#   2  usage / tooling error

set -euo pipefail

NAMESPACE="${NAMESPACE:-buzz}"
OUTPUT=""
INTERVAL=60
DURATION="24h"
SELECTOR="app.kubernetes.io/name=buzz"
VIA=proxy
ONCE=false
SUMMARY_FILE=""
METRICS_PORT="${METRICS_PORT:-9102}"

die() { printf 'FAIL: %s\n' "$*" >&2; exit 2; }

# Metrics collected, and why each one earns a column. Every name here was
# checked against the relay source — a column that is always empty because the
# metric does not exist is worse than no column.
#   buzz_ws_connections_active            gauge   THE soak signal (connection.rs:201/284)
#   buzz_total_ws_connections             gauge   cluster-wide total across pods
#   buzz_ws_backpressure_disconnects_total counter slow-client evictions
#   buzz_ws_auth_timeouts_total           counter clients that never completed NIP-42
#   buzz_auth_attempts_total              counter reconnect proxy — see the note below
#   buzz_auth_failures_total              counter
#   buzz_admission_rejections_total       counter rate-limit rejections (fails CLOSED on Redis errors)
#   buzz_events_received_total            counter traffic denominator
#   buzz_db_pool_active                   gauge   Postgres pressure (the litellm RCA metric)
#
# THERE IS NO RECONNECT COUNTER in the relay. `buzz_auth_attempts_total` is the
# stand-in: every new WebSocket connection re-runs NIP-42, so a rising auth rate
# with a flat connection gauge is a reconnect storm. Do not report it as a
# literal reconnect count.
METRICS=(
  buzz_ws_connections_active
  buzz_total_ws_connections
  buzz_ws_backpressure_disconnects_total
  buzz_ws_auth_timeouts_total
  buzz_auth_attempts_total
  buzz_auth_failures_total
  buzz_admission_rejections_total
  buzz_events_received_total
  buzz_db_pool_active
)

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--namespace) NAMESPACE="${2:?}"; shift 2 ;;
    -o|--output)    OUTPUT="${2:?}"; shift 2 ;;
    --interval)     INTERVAL="${2:?}"; shift 2 ;;
    --duration)     DURATION="${2:?}"; shift 2 ;;
    --selector)     SELECTOR="${2:?}"; shift 2 ;;
    --via)          VIA="${2:?}"; shift 2 ;;
    --once)         ONCE=true; shift ;;
    --summary)      SUMMARY_FILE="${2:?}"; shift 2 ;;
    -h|--help)      sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# ── --summary: read an existing CSV, deliver the verdict ────────────────────
if [ -n "$SUMMARY_FILE" ]; then
  [ -f "$SUMMARY_FILE" ] || die "no such CSV: ${SUMMARY_FILE}"
  command -v awk >/dev/null 2>&1 || die "awk not on PATH"
  awk -F, '
    NR == 1 { for (i = 1; i <= NF; i++) col[$i] = i; next }
    {
      pod = $col["pod"]
      ticks[pod]++
      active = $col["buzz_ws_connections_active"] + 0
      if (pod in prev_active) {
        drop = prev_active[pod] - active
        if (drop > 0) {
          total_drop[pod] += drop
          # A drop with no matching backpressure disconnect in the same window
          # is UNEXPLAINED — that is the ALB/idle-timeout/VPN-MTU signature the
          # soak is hunting. A drop that matches a backpressure counter rise is
          # explained (a slow client got evicted, working as designed).
          bp = $col["buzz_ws_backpressure_disconnects_total"] + 0
          if (bp <= prev_bp[pod]) unexplained[pod] += drop
        }
      }
      prev_active[pod] = active
      prev_bp[pod] = $col["buzz_ws_backpressure_disconnects_total"] + 0
      if (first[pod] == "") first[pod] = $col["timestamp"]
      last[pod] = $col["timestamp"]
      if (active > peak[pod]) peak[pod] = active
    }
    END {
      printf "soak summary: %s\n\n", FILENAME
      bad = 0
      for (p in ticks) {
        printf "  pod %s\n", p
        printf "    window      : %s .. %s (%d ticks)\n", first[p], last[p], ticks[p]
        printf "    peak active : %d\n", peak[p]
        printf "    total drop  : %d\n", total_drop[p] + 0
        printf "    UNEXPLAINED : %d\n", unexplained[p] + 0
        if (unexplained[p] + 0 > 0) bad = 1
      }
      printf "\n"
      if (bad) {
        print "  VERDICT: unexplained WS drops present — risk R2 is NOT cleared."
        print "  Cross-check the ALB idle timeout (must be 3600), deploy events in the"
        print "  window (a rollout drains connections and is an EXPLAINED drop — annotate"
        print "  it), and Redis restarts (readiness pings Redis; a restart flips every"
        print "  replica NotReady at once)."
        exit 1
      }
      print "  VERDICT: no unexplained WS drops."
    }
  ' "$SUMMARY_FILE"
  exit $?
fi

[ -n "$OUTPUT" ] || die "give an output CSV with -o/--output"
command -v kubectl >/dev/null 2>&1 || die "kubectl not on PATH"
case "$VIA" in proxy|exec) ;; *) die "--via must be proxy or exec" ;; esac

# ── duration parsing ────────────────────────────────────────────────────────
case "$DURATION" in
  *h) DURATION_SECS=$(( ${DURATION%h} * 3600 )) ;;
  *m) DURATION_SECS=$(( ${DURATION%m} * 60 )) ;;
  *s) DURATION_SECS=${DURATION%s} ;;
  *)  DURATION_SECS=$DURATION ;;
esac
[ "$ONCE" = true ] && DURATION_SECS=0

# ── CSV header ──────────────────────────────────────────────────────────────
if [ ! -s "$OUTPUT" ]; then
  { printf 'timestamp,pod'; for m in "${METRICS[@]}"; do printf ',%s' "$m"; done; printf '\n'; } > "$OUTPUT"
fi

scrape_pod() {
  # Emits the raw Prometheus exposition text for one Pod.
  local pod="$1"
  if [ "$VIA" = proxy ]; then
    kubectl get --raw "/api/v1/namespaces/${NAMESPACE}/pods/${pod}:${METRICS_PORT}/proxy/metrics" 2>/dev/null
  else
    kubectl -n "$NAMESPACE" exec "$pod" -- \
      curl -sf --max-time 10 "http://localhost:${METRICS_PORT}/metrics" 2>/dev/null
  fi
}

extract() {
  # $1 = exposition text, $2 = metric name. SUMS every labelled series under
  # that name: buzz_admission_rejections_total is emitted per limit_type, and
  # taking the first series would silently under-report.
  printf '%s\n' "$1" | awk -v name="$2" '
    $0 ~ "^"name"([{ ]|$)" {
      v = $NF
      if (v + 0 == v) { sum += v; seen = 1 }
    }
    END { if (seen) printf "%g", sum; else printf "" }
  '
}

tick() {
  local ts pods pod text row value
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  pods="$(kubectl -n "$NAMESPACE" get pods -l "$SELECTOR" \
            --field-selector=status.phase=Running \
            -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' 2>/dev/null || true)"
  if [ -z "$pods" ]; then
    # Record the gap rather than skipping it. A silent hole in the CSV during an
    # outage is exactly the evidence the soak needed most.
    printf '%s,NO_PODS' "$ts" >> "$OUTPUT"
    for _ in "${METRICS[@]}"; do printf ',' >> "$OUTPUT"; done
    printf '\n' >> "$OUTPUT"
    return 0
  fi
  while read -r pod; do
    [ -n "$pod" ] || continue
    text="$(scrape_pod "$pod" || true)"
    row="${ts},${pod}"
    for m in "${METRICS[@]}"; do
      value="$(extract "$text" "$m")"
      row="${row},${value}"
    done
    printf '%s\n' "$row" >> "$OUTPUT"
  done <<< "$pods"
}

printf 'buzz relay soak — node N8\n'
printf '  namespace : %s (selector %s)\n' "$NAMESPACE" "$SELECTOR"
printf '  output    : %s\n' "$OUTPUT"
printf '  interval  : %ss   duration: %s\n' "$INTERVAL" "$([ "$DURATION_SECS" -eq 0 ] && echo 'single tick / forever' || echo "${DURATION_SECS}s")"
printf '  scrape    : %s\n\n' "$VIA"

START="$(date +%s)"
tick
if [ "$ONCE" = true ]; then
  printf 'single tick written.\n'
  exit 0
fi

# Ctrl-C leaves a usable CSV — the summary works on a partial file.
trap 'printf "\ninterrupted; %s holds what was collected. Analyse with: %s --summary %s\n" "$OUTPUT" "$0" "$OUTPUT"; exit 0' INT TERM

while true; do
  sleep "$INTERVAL"
  tick
  if [ "$DURATION_SECS" -gt 0 ] && [ $(( $(date +%s) - START )) -ge "$DURATION_SECS" ]; then
    break
  fi
done

printf '\ncollection complete.\n'
printf 'Verdict: %s --summary %s\n' "$0" "$OUTPUT"
printf 'Archive the CSV on the AIFM ticket — it is the phase-0 R2 evidence.\n'
