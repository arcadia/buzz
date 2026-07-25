{{/* Naming, labels, and the composed identifiers this wrapper owns. */}}

{{- define "buzz-arcadia.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "buzz-arcadia.fullname" -}}
{{- default .Release.Name .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "buzz-arcadia.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "buzz-arcadia.labels" -}}
helm.sh/chart: {{ include "buzz-arcadia.chart" . }}
{{ include "buzz-arcadia.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: buzz
{{- end -}}

{{- define "buzz-arcadia.selectorLabels" -}}
app.kubernetes.io/name: {{ include "buzz-arcadia.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/*
Subchart-scoped context.

Named templates are global across a Helm render, but a subchart's helpers must
be evaluated against the subchart's own scope (.Chart.Name = "buzz",
.Values = .Values.buzz) or they compute the wrong names. Building that scope
explicitly keeps the wrapper's Ingress backend and NetworkPolicy selectors
correct even if someone sets buzz.nameOverride / buzz.fullnameOverride.
*/}}
{{- define "buzz-arcadia.relayFullname" -}}
{{- include "buzz.fullname" (dict "Chart" (dict "Name" "buzz") "Release" .Release "Values" .Values.buzz) -}}
{{- end -}}

{{- define "buzz-arcadia.relaySelectorLabels" -}}
{{- include "buzz.relaySelectorLabels" (dict "Chart" (dict "Name" "buzz") "Release" .Release "Values" .Values.buzz) -}}
{{- end -}}

{{/*
<account>.dkr.ecr.<region>.amazonaws.com — the cluster account's own ECR.

toString is load-bearing: the global patch injects `account` as a helm
parameter, and `--set account=258174056699` types it as an int64, which
`printf "%s"` would render as "%!s(int64=258174056699)".
*/}}
{{- define "buzz-arcadia.ecrRegistry" -}}
{{- $account := required "account is required (injected by the cluster global-helm-values-patch)" .Values.account | toString -}}
{{- $region := required "region is required (injected by the cluster global-helm-values-patch)" .Values.region | toString -}}
{{- printf "%s.dkr.ecr.%s.amazonaws.com" $account $region -}}
{{- end -}}

{{/* The relay image repository the Application is required to supply. */}}
{{- define "buzz-arcadia.relayImageRepository" -}}
{{- printf "%s/%s" (include "buzz-arcadia.ecrRegistry" .) .Values.relayImage.repositoryPath -}}
{{- end -}}

{{- define "buzz-arcadia.redisFullname" -}}
{{- printf "%s-redis" (include "buzz-arcadia.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "buzz-arcadia.redisImage" -}}
{{- printf "%s/%s:%s" (include "buzz-arcadia.ecrRegistry" .) .Values.redis.image.repositoryPath (required "redis.image.tag is required (ECR mirror tag)" .Values.redis.image.tag) -}}
{{- end -}}

{{- define "buzz-arcadia.redisHost" -}}
{{- printf "%s.%s.svc.cluster.local" (include "buzz-arcadia.redisFullname" .) .Release.Namespace -}}
{{- end -}}

{{/* Crossplane claim object name — prefixed with clusterName for IAM scoping. */}}
{{- define "buzz-arcadia.rdsClaimName" -}}
{{- printf "%s-%s" (required "clusterName is required (injected by the cluster global-helm-values-patch)" .Values.clusterName) .Values.rds.claimName -}}
{{- end -}}

{{/*
Connection Secret Crossplane writes: {namespace}-{claimName}-connection, where
claimName already carries the clusterName prefix.
*/}}
{{- define "buzz-arcadia.rdsConnectionSecretName" -}}
{{- if .Values.database.connectionSecret.name -}}
{{- .Values.database.connectionSecret.name -}}
{{- else -}}
{{- printf "%s-%s-connection" .Release.Namespace (include "buzz-arcadia.rdsClaimName" .) -}}
{{- end -}}
{{- end -}}

{{/* SSM prefix: /<infrastructure>/<clusterName> unless overridden. */}}
{{- define "buzz-arcadia.ssmPrefix" -}}
{{- if .Values.externalSecret.ssmPathPrefix -}}
{{- .Values.externalSecret.ssmPathPrefix | trimSuffix "/" -}}
{{- else -}}
{{- printf "/%s/%s" (required "infrastructure is required (injected by the cluster global-helm-values-patch)" .Values.infrastructure) (required "clusterName is required (injected by the cluster global-helm-values-patch)" .Values.clusterName) -}}
{{- end -}}
{{- end -}}

{{/* Public relay host — must match buzz.relayUrl's authority. */}}
{{- define "buzz-arcadia.relayHost" -}}
{{- if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- else -}}
{{- printf "%s.%s" .Values.ingress.hostPrefix (required "domainHostedZone is required (injected by the cluster global-helm-values-patch)" .Values.domainHostedZone) -}}
{{- end -}}
{{- end -}}

{{/* Authority of buzz.relayUrl (wss://host[/path] -> host). */}}
{{- define "buzz-arcadia.relayUrlHost" -}}
{{- $url := required "buzz.relayUrl is required" .Values.buzz.relayUrl -}}
{{- $stripped := $url | replace "wss://" "" | replace "ws://" "" -}}
{{- first (splitList "/" $stripped) -}}
{{- end -}}
