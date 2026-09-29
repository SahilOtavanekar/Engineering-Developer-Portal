# Deploying the portal to Rancher with Helm

One Helm chart, one values file per environment, images in ECR. Supersedes the
plain manifests in `k8s/`, which are kept as the record of how each probe and
flag was found.

```
deploy/
  helm/fleet-portal/            the chart
  environments/
    secrets.example.yaml        credential template (committed, empty)
    dev/values.yaml             non-secret settings (committed)
    dev/secrets.yaml            credentials (gitignored -- you create it)
    staging/values.yaml         template, not wired yet
    prod/values.yaml            template, not wired yet
  scripts/
    build-push.sh               build the image, push to ECR
    deploy.sh                   helm upgrade --install for one environment
```

What the chart creates: the portal Deployment + Service, an Ingress
(ingress-nginx), a ConfigMap and Secrets for app-config, an in-cluster Postgres
StatefulSet (dev) or a connection to an external one (staging/prod), and an ECR
pull-secret refresher. The refresher is needed because the clusters are not
EKS, so nodes have no IAM role to pull with, and an ECR token expires after 12
hours.

## Verified, and not

Verified on docker-desktop on 2026-09-27, deployed with `deploy.sh` from the dev
values and reached **through ingress-nginx on a real host name over HTTPS**
(self-signed certificate): Ready in 34 seconds, zero error-level log lines,
all ten plugins, `guest` the only auth provider, and GitHub's auth routes
returning 404. A browser went through guest sign-in, the catalog (106
repositories), a repository page, the Health Dashboard, Productivity, Search,
Settings, a theme switch and a reload. Earlier (2026-09-25): the ECR hook
failed the install fast on bad AWS keys, and with a stand-in token the
refresher created the pull secret and then updated it.

Found by that run, and fixed: plain HTTP on a real host name rendered a blank
page and then broke Search (see the TLS item under step 4).

**Not verified:** a real ECR login and pull, a trusted certificate,
external/RDS mode, and anything on a real Rancher cluster.

## One-time setup

### 1. Tools on your machine

`helm` 3.x, `kubectl`, `docker` (BuildKit), `aws` CLI v2, and Git Bash to run
the scripts on Windows.

### 2. AWS: the ECR repository and two IAM users

```bash
aws ecr create-repository --repository-name fleet-portal --region <region> \
  --image-scanning-configuration scanOnPush=true
```

Use **two separate** IAM users, so a credential stored in the cluster can only
pull:

| user                | used by                                   | policy                                                                                                                                                                                                                                    |
| ------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-portal-push` | you, in `build-push.sh` (`aws configure`) | `ecr:GetAuthorizationToken` on `*`; `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:DescribeRepositories` on the repository ARN |
| `fleet-portal-pull` | the cluster (`secrets.yaml`)              | `ecr:GetAuthorizationToken` on `*`; `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, `ecr:BatchCheckLayerAvailability` on the repository ARN                                                                                            |

The repository ARN is `arn:aws:ecr:<region>:<account-id>:repository/fleet-portal`.

Sign-in needs no setup. **Guest is the only sign-in method**: GitHub was
removed on 2026-09-27, and Entra ID is the planned replacement. Everyone who
reaches the host clicks **Enter** and becomes the same shared identity,
`user:default/guest`. The chart refuses to render with
`portal.auth.allowGuestSignIn: false`, because that would deploy a portal
nobody can sign in to.

### 3. Bitbucket credential

Either a workspace access token (`bitbucket.token`) or username + password
(`bitbucket.username` + `bitbucket.appPassword`). For an Atlassian API token,
the username is your Atlassian **email**. It needs read access to repositories,
pull requests and pipelines in the `demandai` workspace.

### 4. The Rancher cluster

- **kubeconfig:** Rancher UI > the cluster > "Download KubeConfig" (or "Copy
  KubeConfig"). Save it and `export KUBECONFIG=<file>`, or merge it and select
  the context. `deploy.sh` prints the context and asks before it changes
  anything.
- **Ingress class:** `kubectl get ingressclass` should list `nginx`.
- **Storage class:** `kubectl get storageclass`. Put the name in
  `dev/values.yaml` under `postgresql.internal.persistence.storageClass`. RKE2
  ships none, K3s ships `local-path`, and Longhorn clusters have `longhorn`.
  With a wrong name the PVC stays Pending indefinitely, and no error names the
  cause.
- **DNS:** point the dev host at the cluster's ingress (its node IPs or load
  balancer).
- **HTTPS: required, but a certificate is not.** Over plain HTTP on a real
  host name the browser won't treat the page as secure: Search returns
  nothing and some pages throw errors. (A port-forward to `localhost` hides
  this, because browsers exempt localhost.) Dev therefore defaults to
  `ingress.tls.selfSigned: true`: the chart **generates a self-signed
  certificate** for `ingress.host`, reused on every upgrade. Each browser
  warns once ("Your connection is not private"); choose **Advanced → Proceed**.
  With a real certificate later, set `selfSigned: false`, delete the
  generated secret, and create it from your files:

  ```bash
  kubectl -n fleet-dev delete secret fleet-portal-dev-tls
  kubectl -n fleet-dev create secret tls fleet-portal-dev-tls --cert=dev.crt --key=dev.key
  ```

- **Namespace:** `deploy.sh` creates `fleet-dev`. If Rancher Projects matter to
  you, move the namespace into one in the Rancher UI after the first deploy, or
  create it there first.

### 5. Fill in dev

```bash
cp deploy/environments/secrets.example.yaml deploy/environments/dev/secrets.yaml
# fill in dev/secrets.yaml, and every REPLACE in dev/values.yaml
```

## Every release

```bash
# build once...
AWS_ACCOUNT_ID=<id> AWS_REGION=<region> deploy/scripts/build-push.sh
# prints e.g.  Deploy: deploy/scripts/deploy.sh dev 20260925-1130-d03df76

# ...check the cluster accepts it, then deploy
DRY_RUN=1 deploy/scripts/deploy.sh dev 20260925-1130-d03df76
deploy/scripts/deploy.sh dev 20260925-1130-d03df76
```

`deploy.sh` waits until the pod is **Ready**. Ready means every plugin started,
because the readiness endpoint only returns 200 after that. Pin the tag you
deployed in `dev/values.yaml` so the file records what is running.

**Promotion:** deploy the **same tag** to staging and then prod. Never rebuild
for a later environment.

## Deploying with Bitbucket Pipelines

`bitbucket-pipelines.yml` does the same as the two scripts above, on every push
to `main`: it tests, builds and pushes the image to ECR, then deploys dev.
**No credential is stored in Bitbucket or in the repository.** The pipeline
signs in to AWS through Bitbucket's OIDC, and the deploy step reads every
application credential (the portal's Bitbucket username and password or token,
the Postgres password, the ECR pull key) from **AWS Secrets Manager** while it
runs (`deploy/scripts/ci-deploy.sh`). The credentials exist only in a private
temporary folder during the deploy and are deleted afterwards; they never appear in
the build log.

| Trigger                       | What runs                                              |
| ----------------------------- | ------------------------------------------------------ |
| Any pull request              | typecheck, lint, tests                                 |
| Push to `main`                | tests → build and push to ECR → **deploy dev**         |
| Run pipeline → `redeploy-dev` | deploy an existing `IMAGE_TAG` (redeploy or roll back) |

### One-time setup, in this order

1. **Bitbucket:** the repository must live in the `demandai` workspace. Enable
   Pipelines (Repository settings → Pipelines → Settings), then note the
   **Identity provider URL**, **Audience** and **Repository UUID** under
   Repository settings → Pipelines → **OpenID Connect**.
2. **AWS IAM (admin):**
   - Add an **OpenID Connect identity provider** with that provider URL and
     audience.
   - Create a role, e.g. `bitbucket-engineering-portal`, with
     `deploy/aws/pipeline-trust-policy.json` as its trust policy (replace
     `REPLACE_AUDIENCE` and `REPLACE_REPOSITORY_UUID`, keeping the braces).
   - Attach `deploy/aws/pipeline-permissions-policy.json`: ECR push to
     `dai-engineering-portal`, plus read access to **only** the secret below.
3. **AWS Secrets Manager (us-east-1):** create a secret named
   **`engineering-portal/dev`**, type _Other_, with the JSON keys in
   `deploy/aws/portal-secret.example.json`. The Bitbucket credential must be
   in it; the deploy fails and names any missing key (never a value).
   If the secret uses a customer-managed KMS key, the role also needs
   `kms:Decrypt` on that key.
4. **Runner (Rancher admin):** Bitbucket's cloud cannot reach
   `rancher-dev.demandai.local`, so the deploy step runs on a **self-hosted
   runner inside the network** (Repository settings → Runners → Add runner →
   Linux Docker, or the Kubernetes runner). Give it a label and put that label
   in place of `REPLACE_RUNNER_LABEL` in `bitbucket-pipelines.yml`. For cluster
   access, either give the runner's pods a service account allowed to manage
   the `fleet-dev` namespace, or add `kubeconfig_b64` (a kubeconfig limited to
   that namespace, base64-encoded) to the secret.
5. **Variables (not secret):**
   - Repository settings → **Repository variables:** `AWS_ROLE_ARN` (the role
     from step 2) and `AWS_REGION` = `us-east-1`. The build step reads them.
   - Repository settings → **Deployments → dev:** `PORTAL_SECRET_ID` =
     `engineering-portal/dev`.
6. **`deploy/environments/dev/values.yaml`:** set `ingress.host`. A
   `REPLACE` left there makes the deploy stop, deliberately.

### Rotating a credential

Change it in Secrets Manager, then run the pipeline (`redeploy-dev` with the
current tag is enough). The value is copied into the cluster at deploy time,
so a change in Secrets Manager alone does **not** reach a running portal.

### Verified, and not

`ci-deploy.sh` was run on 2026-09-29 in the same Alpine image and with the
same packages as the deploy step, with a stand-in for Secrets Manager, and a
server-side dry run against a Kubernetes API. It named missing keys without
printing values, refused a leftover placeholder, rendered and validated the
chart, left no temporary files, and printed **none** of the five secret values.
The pinned helm and kubectl downloads passed their checksums.
**Not verified:** a real Bitbucket run, the OIDC exchange, a real Secrets
Manager read, and BuildKit's cache mounts on Bitbucket's Docker service
(the Dockerfile uses them; check the first build's log).

## Checking it

Follow the NOTES that `helm` prints after the install, then:

```bash
kubectl -n fleet-dev get pods                 # READY 1/1, not "0/1 Running"
kubectl -n fleet-dev logs deploy/fleet-portal -c backstage | grep -i "threw an error during startup"   # expect nothing
kubectl -n fleet-dev exec fleet-portal-postgres-0 -- \
  psql -U backstage -d backstage_plugin_fleet -c "select count(*) from repository"
```

`k8s/README.md` has the full verification ladder and what each failure means.
Its commands work here too, with namespace `fleet-dev` and the pod names above.

## Rollback, uninstall

```bash
helm -n fleet-dev history fleet-portal
helm -n fleet-dev rollback fleet-portal <revision>
helm -n fleet-dev uninstall fleet-portal
```

After `uninstall` the **Postgres PVC is kept on purpose**, because score
history cannot be backfilled. The ECR refresher's hook objects are kept too
(Helm does not track hooks). `kubectl delete namespace fleet-dev` removes
everything.

## Troubleshooting

| symptom                                                                       | cause                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| install fails on `...-ecr-refresh-init`                                       | bad AWS pull keys or region. `kubectl -n fleet-dev logs job/fleet-portal-ecr-refresh-init -c fetch-token`                                                                                                                                                                                               |
| `ImagePullBackOff`                                                            | the tag is not in ECR, or the pull secret has expired: check `kubectl -n fleet-dev get cronjob,jobs`                                                                                                                                                                                                    |
| stuck in `Init:0/1`                                                           | cannot reach Postgres: `kubectl -n fleet-dev logs deploy/fleet-portal -c wait-for-postgres`                                                                                                                                                                                                             |
| `0/1 Running`, 0 restarts                                                     | a plugin failed at startup (credentials). The startupProbe restarts it after 5 minutes                                                                                                                                                                                                                  |
| page loads, every request fails                                               | `baseUrl` does not match the URL in the browser (http vs https, host)                                                                                                                                                                                                                                   |
| blank page; console shows ERR_CERT_AUTHORITY_INVALID on every script          | the page came over http but its scripts were upgraded to https. The chart prevents this for http base URLs; if you see it, `baseUrl` says https while TLS is not actually served                                                                                                                        |
| Search returns nothing; console says `crypto.randomUUID is not a function`    | served over plain http on a real host name. Enable `ingress.tls`                                                                                                                                                                                                                                        |
| catalog owners read "unowned" for more than ~10 minutes after a first install | the providers re-register as soon as the ownership pass finishes (log: "ran before ownership resolved; refreshing again"). If they gave up ("still unresolved after 8 minutes"), check `ownership:demandai` in `sync_state`; the next 30-minute run retries                                             |
| a pass fails with `429 ... Rate limit for this resource has been exceeded`    | Bitbucket's hourly quota for the credential is spent. The client has already retried (2s, 4s, 8s), and the pass stops instead of failing every remaining repository; the scheduler backs off and retries. Every portal using the same credential shares the quota, so give each environment its own     |
| no scores on the Health Dashboard for ~30 minutes after a first install       | expected: scoring waits until commits, pull requests, branch policy and pull-request size have each finished once (log: "Scoring deferred ... waiting for the first complete run of ..."), so the first scores are correct rather than early. The first pull-request-size sweep alone takes ~15 minutes |
| guest "Enter" fails: "cannot be used outside of a development environment"    | the config reaching the pod lacks `dangerouslyAllowOutsideDevelopment`: check `kubectl -n fleet-dev get cm fleet-portal-app-config -o yaml`. The chart always sets it, so this means something overrode it                                                                                              |

## Before staging and prod

- Fill `staging/values.yaml` / `prod/values.yaml` and create their
  `secrets.yaml`, with **different** credentials.
- They default to `postgresql.mode: external` (RDS). The DB user needs
  **CREATEDB**, because the portal creates one database per plugin.
- **Open decision 6 in CLAUDE.md is still open.** The backend runs
  `allow-all-policy`, and the productivity page serves per-person figures to
  anyone who can sign in. Treat that as blocking before prod.
