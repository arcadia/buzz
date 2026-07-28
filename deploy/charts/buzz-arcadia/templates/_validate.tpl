{{/*
Hard fail guards for the Arcadia wrapper, included from every template it
renders so a misconfiguration surfaces at template time (i.e. in the Argo CD
repo-server, before anything is applied) regardless of render order.

These encode decisions from the pivot spec's decision log; each guard names the
decision it protects.
*/}}

{{- define "buzz-arcadia.validate" -}}

{{/* ── Injected globals ───────────────────────────────────────────────── */}}
{{- range $key := (list "account" "region" "clusterName" "infrastructure") -}}
  {{- if not (index $.Values $key) -}}
    {{- fail (printf "%s is required: it is injected as a parent-level helm parameter by the cluster's global-helm-values-patch.yaml. Rendering without it would deploy into the wrong account/environment." $key) -}}
  {{- end -}}
{{- end -}}

{{/* ── Relay image (D1: in-account ECR only, no GHCR, no docker.io) ───── */}}
{{- if not .Values.buzz.image.tag -}}
  {{- fail "buzz.image.tag must be set explicitly. An empty tag silently falls back to the subchart appVersion (0.1.0), which the ECR repository does not publish." -}}
{{- end -}}
{{- if .Values.relayImage.enforceComposedRepository -}}
  {{- $expected := include "buzz-arcadia.relayImageRepository" . -}}
  {{- if ne .Values.buzz.image.repository $expected -}}
    {{- fail (printf "buzz.image.repository must be %q (composed from the injected account/region globals), got %q. The clusters have no internet egress and no cross-account pull: the relay image must come from this account's own ECR. Set relayImage.enforceComposedRepository=false only for a deliberate mirror." $expected .Values.buzz.image.repository) -}}
  {{- end -}}
{{- end -}}

{{/* ── GitOps secret safety ───────────────────────────────────────────── */}}
{{- if .Values.externalSecret.enabled -}}
  {{- if ne .Values.buzz.secrets.existingSecret .Values.externalSecret.targetName -}}
    {{- fail (printf "buzz.secrets.existingSecret (%q) must equal externalSecret.targetName (%q): the relay reads BUZZ_RELAY_PRIVATE_KEY / DATABASE_URL / REDIS_URL from that one Secret." .Values.buzz.secrets.existingSecret .Values.externalSecret.targetName) -}}
  {{- end -}}
{{- end -}}
{{- if not .Values.buzz.secrets.existingSecret -}}
  {{- fail "buzz.secrets.existingSecret is mandatory under Argo CD: without it the subchart's own Secret template uses lookup + randAlphaNum, which regenerates the relay identity on every sync." -}}
{{- end -}}
{{/* Secret keys are referenced as `{{ .KEY }}` in the ESO target template, so
     they must be valid Go template identifiers — a hyphenated key renders here
     but breaks inside ESO, where it is much harder to see. */}}
{{- range $key, $path := .Values.externalSecret.data -}}
  {{- if not (regexMatch "^[A-Za-z_][A-Za-z0-9_]*$" $key) -}}
    {{- fail (printf "externalSecret.data key %q must match ^[A-Za-z_][A-Za-z0-9_]*$: it is dereferenced as {{ .%s }} in the ExternalSecret target template." $key $key) -}}
  {{- end -}}
{{- end -}}

{{/* ── Host binding (relay resolves its community from the Host header) ─ */}}
{{- if .Values.ingress.enabled -}}
  {{- $ingressHost := include "buzz-arcadia.relayHost" . -}}
  {{- $relayUrlHost := include "buzz-arcadia.relayUrlHost" . -}}
  {{- if ne $ingressHost $relayUrlHost -}}
    {{- fail (printf "ingress host %q must equal the authority of buzz.relayUrl (%q). The relay binds a community from the Host header before the WebSocket upgrade and fails closed on an unmapped host (crates/buzz-relay/src/router.rs:280-298)." $ingressHost $relayUrlHost) -}}
  {{- end -}}
  {{- if not .Values.domainCertArn -}}
    {{- fail "domainCertArn is required when ingress.enabled=true (injected by the cluster global-helm-values-patch)." -}}
  {{- end -}}
{{- end -}}

{{/* ── Bundled eval-only subcharts are GONE from the vendored chart ───── */}}
{{- if or .Values.buzz.postgresql.enabled .Values.buzz.redis.enabled -}}
  {{- fail "buzz.postgresql.enabled / buzz.redis.enabled must stay false: the cloudpirates OCI dependencies were removed from the vendored chart (no cluster internet egress, D1). Postgres is the Crossplane RDS claim, Redis is templates/redis.yaml." -}}
{{- end -}}

{{/* ── No S3 in phase 0 (D5 / N18) ────────────────────────────────────── */}}
{{- if or .Values.buzz.minio.enabled .Values.buzz.s3.endpoint .Values.buzz.s3.accessKey .Values.buzz.s3.secretKey -}}
  {{- fail "S3/media is out of phase 0: the git-on-object-storage conformance probe is disabled (BUZZ_GIT_CONFORMANCE_PROBE=false) and no bucket claim or credentials exist. N18 brings a Crossplane Bucket claim + IRSA, and must also force-empty BUZZ_S3_ACCESS_KEY/BUZZ_S3_SECRET_KEY (their unset defaults are the literals buzz_dev/buzz_dev_secret)." -}}
{{- end -}}

{{/* ── Observability (no Prometheus Operator CRDs on these clusters) ──── */}}
{{- if .Values.buzz.serviceMonitor.enabled -}}
  {{- fail "buzz.serviceMonitor.enabled must be false: neither dev-ai nor prd-ai runs the Prometheus Operator, so the ServiceMonitor CRD does not exist. Scraping is Alloy River config in cloud-config-templates (N14)." -}}
{{- end -}}

{{/* ── RDS claim inputs ───────────────────────────────────────────────── */}}
{{- if .Values.rds.enabled -}}
  {{- if not .Values.rds.subnetIds -}}
    {{- fail "rds.subnetIds is required (three private subnets for the environment; see the chart README)." -}}
  {{- end -}}
  {{- if not .Values.rds.cidrBlocks -}}
    {{- fail "rds.cidrBlocks is required (the environment's VPC CIDRs — they scope the DB security group)." -}}
  {{- end -}}
  {{- if not .Values.rds.providerConfigRefName -}}
    {{- fail "rds.providerConfigRefName is required by the Crossplane RDS claim schema." -}}
  {{- end -}}
{{- else -}}
  {{- if not .Values.database.connectionSecret.name -}}
    {{- fail "database.connectionSecret.name is required when rds.enabled=false: DATABASE_URL is composed from an existing Crossplane connection Secret." -}}
  {{- end -}}
{{- end -}}

{{/* ── NetworkPolicy CIDRs must be the real VPC ranges ────────────────── */}}
{{- if .Values.networkPolicy.enabled -}}
  {{- if not .Values.networkPolicy.allowedIngressCidrs -}}
    {{- fail "networkPolicy.allowedIngressCidrs is required when networkPolicy.enabled=true: set the environment's VPC CIDRs (dev-ai 10.54.0.0/17 + 10.54.128.0/17, prd-ai 10.52.0.0/17 + 10.52.128.0/17)." -}}
  {{- end -}}
  {{- range .Values.networkPolicy.allowedIngressCidrs -}}
    {{- if eq . "10.0.0.0/8" -}}
      {{- fail "networkPolicy.allowedIngressCidrs must not contain 10.0.0.0/8 — that is every RFC1918 /8 range, not a boundary. Use the environment's VPC CIDRs." -}}
    {{- end -}}
  {{- end -}}
{{- end -}}

{{- end -}}
