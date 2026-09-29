#!/usr/bin/env bash
# Install or upgrade the portal in one environment.
#
#   deploy/scripts/deploy.sh <dev|staging|prod> [image-tag]
#
# Uses the current kubectl context (the kubeconfig downloaded from Rancher),
# unless KUBE_CONTEXT is set. Namespace defaults to fleet-<env>; override with
# NAMESPACE. DRY_RUN=1 renders and validates against the cluster without
# changing anything. SECRETS_FILE points at a credentials file other than
# deploy/environments/<env>/secrets.yaml -- the pipeline writes one to a
# temporary directory from AWS Secrets Manager (see ci-deploy.sh).
set -euo pipefail

ENV="${1:?usage: deploy.sh <dev|staging|prod> [image-tag]}"
TAG="${2:-}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CHART="$ROOT/deploy/helm/fleet-portal"
ENV_DIR="$ROOT/deploy/environments/$ENV"
NAMESPACE="${NAMESPACE:-fleet-$ENV}"
RELEASE="${RELEASE:-fleet-portal}"
SECRETS_FILE="${SECRETS_FILE:-$ENV_DIR/secrets.yaml}"

[ -f "$ENV_DIR/values.yaml" ] || { echo "no such environment: $ENV_DIR/values.yaml"; exit 1; }
[ -f "$SECRETS_FILE" ] || {
  echo "missing $SECRETS_FILE"
  echo "  cp deploy/environments/secrets.example.yaml deploy/environments/$ENV/secrets.yaml  # then fill it"
  exit 1
}

# A placeholder left in values.yaml would deploy something that looks right
# and points nowhere. The image tag is exempt when passed on the command line.
LEFT="$(grep -n 'REPLACE' "$ENV_DIR/values.yaml" | grep -v '^\s*[0-9]*:\s*#' || true)"
if [ -n "$TAG" ]; then LEFT="$(printf '%s\n' "$LEFT" | grep -v 'REPLACE_WITH_TAG' || true)"; fi
if [ -n "$LEFT" ]; then
  echo "Unfilled placeholders in $ENV_DIR/values.yaml:"
  printf '%s\n' "$LEFT"
  exit 1
fi

CTX_ARGS=()
if [ -n "${KUBE_CONTEXT:-}" ]; then CTX_ARGS=(--kube-context "$KUBE_CONTEXT"); fi
# A runner inside the cluster uses its service account and has no kubeconfig,
# so no current context: report that rather than failing on it.
CURRENT_CTX="${KUBE_CONTEXT:-$(kubectl config current-context 2>/dev/null || echo 'in-cluster service account')}"

SET_ARGS=()
if [ -n "$TAG" ]; then SET_ARGS=(--set-string "image.tag=$TAG"); fi

echo "Environment : $ENV"
echo "Context     : $CURRENT_CTX"
echo "Namespace   : $NAMESPACE"
echo "Release     : $RELEASE"
echo "Image tag   : ${TAG:-(from values.yaml)}"

if [ "${DRY_RUN:-}" = "1" ]; then
  helm upgrade --install "$RELEASE" "$CHART" "${CTX_ARGS[@]}" \
    --namespace "$NAMESPACE" --create-namespace \
    -f "$ENV_DIR/values.yaml" -f "$SECRETS_FILE" "${SET_ARGS[@]}" \
    --dry-run=server >/dev/null
  echo "Dry run OK -- the chart renders and the cluster accepts every object."
  exit 0
fi

if [ "${YES:-}" != "1" ]; then
  read -r -p "Deploy to '$CURRENT_CTX' / $NAMESPACE? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

# --wait: returns only when the pod is Ready, which here means every plugin
# started (the readiness endpoint flips only then). No --atomic, so a failed
# release stays in place to be inspected rather than being rolled away.
helm upgrade --install "$RELEASE" "$CHART" "${CTX_ARGS[@]}" \
  --namespace "$NAMESPACE" --create-namespace \
  -f "$ENV_DIR/values.yaml" -f "$SECRETS_FILE" "${SET_ARGS[@]}" \
  --wait --timeout 10m
