#!/usr/bin/env bash
# Build the portal image and push it to ECR. Run from Git Bash on Windows, or
# any bash. Needs: node/yarn, docker (BuildKit), aws CLI v2.
#
#   AWS_ACCOUNT_ID=123456789012 AWS_REGION=ap-south-1 deploy/scripts/build-push.sh
#
# Optional:
#   ECR_REPOSITORY  repository name        (default: fleet-portal)
#   TAG             image tag              (default: <yyyymmdd-hhmm>-<git sha>)
#   AWS_PROFILE     aws CLI profile to push with
#   SKIP_BUILD=1    reuse the existing packages/backend/dist bundle
#
# The same image is promoted through every environment: build once, deploy the
# tag to dev, then to staging and prod. Never rebuild for a later environment.
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID}"
: "${AWS_REGION:?set AWS_REGION}"
ECR_REPOSITORY="${ECR_REPOSITORY:-fleet-portal}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SHA="$(git rev-parse --short HEAD)"
TAG="${TAG:-$(date -u +%Y%m%d-%H%M)-$SHA}"
REGISTRY="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"
IMAGE="$REGISTRY/$ECR_REPOSITORY:$TAG"

if [ -n "$(git status --porcelain)" ]; then
  echo "WARNING: the working tree has uncommitted changes. The tag names commit"
  echo "$SHA, but the image will contain what is on disk."
  read -r -p "Continue anyway? [y/N] " answer
  [ "$answer" = "y" ] || exit 1
fi

if [ "${SKIP_BUILD:-}" != "1" ]; then
  echo "==> yarn install / tsc / build:all"
  yarn install --immutable
  yarn tsc
  # build:all, NOT build:backend -- the frontend must be compiled first or the
  # backend bundle carries no app to serve.
  yarn build:all
fi

echo "==> docker build $IMAGE"
# linux/amd64: cluster nodes are amd64 even when the build machine is not.
DOCKER_BUILDKIT=1 docker build \
  --platform linux/amd64 \
  -f packages/backend/Dockerfile \
  -t "$IMAGE" \
  .

echo "==> ecr login $REGISTRY"
aws ecr describe-repositories --region "$AWS_REGION" --repository-names "$ECR_REPOSITORY" >/dev/null \
  || { echo "ECR repository '$ECR_REPOSITORY' not found in $AWS_REGION -- create it first (see deploy/README.md)"; exit 1; }
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

echo "==> docker push $IMAGE"
docker push "$IMAGE"

echo
echo "Pushed: $IMAGE"
echo "Deploy: deploy/scripts/deploy.sh dev $TAG"
