{{- define "fleet-portal.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fleet-portal.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "fleet-portal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "fleet-portal.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.environment }}
app.kubernetes.io/environment: {{ . }}
{{- end }}
{{- end -}}

{{/* Selector labels take a component so the portal and Postgres never match each other. */}}
{{- define "fleet-portal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fleet-portal.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "fleet-portal.image" -}}
{{- $repo := required "image.repository is required (<account>.dkr.ecr.<region>.amazonaws.com/<repo>)" .Values.image.repository -}}
{{- $tag := required "image.tag is required -- use a dated or git-sha tag, never latest" .Values.image.tag -}}
{{- printf "%s:%s" $repo $tag -}}
{{- end -}}

{{- define "fleet-portal.baseUrl" -}}
{{- if .Values.portal.baseUrl -}}
{{- .Values.portal.baseUrl | trimSuffix "/" -}}
{{- else if .Values.ingress.enabled -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) (required "ingress.host is required when ingress.enabled" .Values.ingress.host) -}}
{{- else -}}
http://localhost:7007
{{- end -}}
{{- end -}}

{{- define "fleet-portal.postgresFullname" -}}
{{- printf "%s-postgres" (include "fleet-portal.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "fleet-portal.postgresHost" -}}
{{- if eq .Values.postgresql.mode "internal" -}}
{{- printf "%s.%s.svc.cluster.local" (include "fleet-portal.postgresFullname" .) .Release.Namespace -}}
{{- else if eq .Values.postgresql.mode "external" -}}
{{- required "postgresql.external.host is required when postgresql.mode is external" .Values.postgresql.external.host -}}
{{- else -}}
{{- fail (printf "postgresql.mode must be internal or external, got %q" .Values.postgresql.mode) -}}
{{- end -}}
{{- end -}}

{{- define "fleet-portal.postgresPort" -}}
{{- if eq .Values.postgresql.mode "internal" -}}5432{{- else -}}{{ .Values.postgresql.external.port }}{{- end -}}
{{- end -}}

{{/* <account>.dkr.ecr.<region>.amazonaws.com, from image.repository unless set. */}}
{{- define "fleet-portal.ecrRegistry" -}}
{{- .Values.ecr.pullSecret.registry | default (index (splitList "/" .Values.image.repository) 0) -}}
{{- end -}}

{{- define "fleet-portal.ecrRegion" -}}
{{- if .Values.ecr.pullSecret.region -}}
{{- .Values.ecr.pullSecret.region -}}
{{- else -}}
{{- $parts := splitList "." (include "fleet-portal.ecrRegistry" .) -}}
{{- if and (ge (len $parts) 4) (eq (index $parts 1) "dkr") (eq (index $parts 2) "ecr") -}}
{{- index $parts 3 -}}
{{- else -}}
{{- fail "ecr.pullSecret.region is required: it cannot be derived from image.repository" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "fleet-portal.ecrAwsSecretName" -}}
{{- .Values.ecr.pullSecret.aws.existingSecret | default (printf "%s-ecr-aws" (include "fleet-portal.fullname" .)) -}}
{{- end -}}

{{/*
Fails the render, rather than the pod, when a credential is missing -- without
one a plugin throws at startup and the pod hangs Running-but-never-Ready -- or
when the configuration would leave no way to sign in.
*/}}
{{- define "fleet-portal.validate" -}}
{{- $_ := required "postgresql.auth.password is required (secrets.yaml)" .Values.postgresql.auth.password -}}
{{- if not .Values.portal.auth.allowGuestSignIn -}}
{{- fail "portal.auth.allowGuestSignIn must be true: guest is the only sign-in method (GitHub was removed), so with it off nobody could sign in" -}}
{{- end -}}
{{- if not (or .Values.bitbucket.token (and .Values.bitbucket.username .Values.bitbucket.appPassword)) -}}
{{- fail "bitbucket: set either bitbucket.token, or both bitbucket.username and bitbucket.appPassword (secrets.yaml)" -}}
{{- end -}}
{{- if and .Values.ecr.pullSecret.enabled (not .Values.ecr.pullSecret.aws.existingSecret) -}}
{{- $_ := required "ecr.pullSecret.aws.accessKeyId is required (secrets.yaml)" .Values.ecr.pullSecret.aws.accessKeyId -}}
{{- $_ := required "ecr.pullSecret.aws.secretAccessKey is required (secrets.yaml)" .Values.ecr.pullSecret.aws.secretAccessKey -}}
{{- end -}}
{{- end -}}
