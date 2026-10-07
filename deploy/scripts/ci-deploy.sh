#!/usr/bin/env bash
# Deploy from Bitbucket Pipelines, with every credential read from AWS Secrets
# Manager at run time -- nothing is stored in Bitbucket or in the repository.
#
#   deploy/scripts/ci-deploy.sh <env> [image-tag]
#
# The tag defaults to IMAGE_TAG, then to image-tag.txt left by the build step.
#
# Bitbucket deployment variables (none of them secret):
#   AWS_REGION        region of the secret, e.g. us-east-1
#   AWS_ROLE_ARN      role the step assumes through OIDC (the step needs `oidc: true`)
#   PORTAL_SECRET_ID  the Secrets Manager secret, e.g. engineering-portal/dev
#
# The secret is one JSON object; deploy/aws/portal-secret.example.json lists
# its keys. The Bitbucket credential MUST be in it. The others may instead come
# from Bitbucket secured variables of the same meaning (POSTGRES_PASSWORD,
# ECR_PULL_ACCESS_KEY_ID, ECR_PULL_SECRET_ACCESS_KEY, KUBECONFIG_B64); the
# secret wins when both are set.
#
# Credentials are written only to a mode-700 temporary directory, never
# printed, and removed on exit whatever happens. Set -x is deliberately absent:
# it would echo every value into the build log.
set -euo pipefail
# Every file this script writes holds a credential: owner-only, from the start.
umask 077

ENV="${1:?usage: ci-deploy.sh <env> [image-tag]}"
TAG="${2:-${IMAGE_TAG:-}}"
if [ -z "$TAG" ] && [ -f image-tag.txt ]; then TAG="$(cat image-tag.txt)"; fi
: "${TAG:?no image tag: pass one, set IMAGE_TAG, or run after the build step}"
: "${AWS_REGION:?set AWS_REGION (a deployment variable)}"
: "${PORTAL_SECRET_ID:?set PORTAL_SECRET_ID (a deployment variable), e.g. engineering-portal/$ENV}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT

# OIDC: Bitbucket hands the step a short-lived token; the AWS CLI exchanges it
# for credentials of AWS_ROLE_ARN by itself when these two are set.
if [ -n "${BITBUCKET_STEP_OIDC_TOKEN:-}" ]; then
  : "${AWS_ROLE_ARN:?set AWS_ROLE_ARN (a deployment variable)}"
  printf '%s' "$BITBUCKET_STEP_OIDC_TOKEN" > "$WORK/oidc-token"
  export AWS_WEB_IDENTITY_TOKEN_FILE="$WORK/oidc-token"
  export AWS_ROLE_SESSION_NAME="bitbucket-deploy-${BITBUCKET_BUILD_NUMBER:-local}"
fi

echo "==> reading '$PORTAL_SECRET_ID' from AWS Secrets Manager ($AWS_REGION)"
aws secretsmanager get-secret-value \
  --region "$AWS_REGION" --secret-id "$PORTAL_SECRET_ID" \
  --query SecretString --output text > "$WORK/secret.json"

# Name what is missing -- never what is present, and never a value.
MISSING="$(jq -r '
  def has_value(k): (.[k] // "") != "";
  [ (if (has_value("bitbucket_token") or (has_value("bitbucket_username") and has_value("bitbucket_app_password")))
       then empty else "bitbucket_token (or bitbucket_username + bitbucket_app_password)" end),
    (if has_value("postgres_password") or ((env.POSTGRES_PASSWORD // "") != "")
       then empty else "postgres_password" end),
    (if has_value("ecr_pull_access_key_id") or ((env.ECR_PULL_ACCESS_KEY_ID // "") != "")
       then empty else "ecr_pull_access_key_id" end),
    (if has_value("ecr_pull_secret_access_key") or ((env.ECR_PULL_SECRET_ACCESS_KEY // "") != "")
       then empty else "ecr_pull_secret_access_key" end)
  ] | join(", ")' "$WORK/secret.json")"
if [ -n "$MISSING" ]; then
  echo "The secret '$PORTAL_SECRET_ID' is missing: $MISSING" >&2
  exit 1
fi

# Helm values file, as JSON (valid YAML). Same shape as secrets.example.yaml.
jq '
  def pick(k; e): if ((.[k] // "") != "") then .[k] else (env[e] // "") end;
  {
    postgresql: { auth: {
      username: (.postgres_username // "backstage"),
      password: pick("postgres_password"; "POSTGRES_PASSWORD") } },
    bitbucket: (if ((.bitbucket_token // "") != "")
      then { token: .bitbucket_token, username: "", appPassword: "" }
      else { token: "", username: .bitbucket_username, appPassword: .bitbucket_app_password } end),
    ecr: { pullSecret: { aws: {
      accessKeyId: pick("ecr_pull_access_key_id"; "ECR_PULL_ACCESS_KEY_ID"),
      secretAccessKey: pick("ecr_pull_secret_access_key"; "ECR_PULL_SECRET_ACCESS_KEY") } } }
  }' "$WORK/secret.json" > "$WORK/secrets.json"

# Cluster access: a kubeconfig from the secret or a secured variable; with
# neither, kubectl and helm fall back to the runner pod's service account.
KUBE_B64="$(jq -r '.kubeconfig_b64 // ""' "$WORK/secret.json")"
KUBE_B64="${KUBE_B64:-${KUBECONFIG_B64:-}}"
if [ -n "$KUBE_B64" ]; then
  printf '%s' "$KUBE_B64" | base64 -d > "$WORK/kubeconfig"
  export KUBECONFIG="$WORK/kubeconfig"
fi
rm -f "$WORK/secret.json"

SECRETS_FILE="$WORK/secrets.json" YES=1 "$ROOT/deploy/scripts/deploy.sh" "$ENV" "$TAG"
