# Deploying the portal to Kubernetes

One backend container serves both the React app and the API on port 7007, plus
Postgres. Written for a Rancher-managed cluster; the manifests are plain
Kubernetes and carry nothing Rancher-specific.

The full runbook, including the failure modes and how they were measured, is
the **Fleet Portal on Rancher** artifact. This file is the short version.

## Before the first apply

**Three secrets. None is optional** — this was measured, not assumed. With any
of them missing a plugin throws during startup and the pod hangs
`Running`-but-never-`Ready` rather than crashing. See the probe comment in
`portal.yaml` for why that happens and what makes it visible.

```bash
kubectl create namespace fleet

kubectl -n fleet create secret generic postgres-credentials \
  --from-literal=POSTGRES_USER=backstage \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)"

kubectl -n fleet create secret generic github-oauth \
  --from-literal=AUTH_GITHUB_CLIENT_ID=... \
  --from-literal=AUTH_GITHUB_CLIENT_SECRET=...

# Bitbucket must be a FILE, not environment variables:
# `integrations.bitbucketCloud` is a list, and an unset ${VAR} makes Backstage
# drop the key -- which turns a clear "no credentials" error into a schema
# failure on a half-built list entry.
kubectl -n fleet create secret generic portal-config \
  --from-file=app-config.secrets.yaml=./app-config.secrets.yaml
```

`app-config.secrets.yaml` is written locally, outside the repository, and never
committed:

```yaml
integrations:
  bitbucketCloud:
    - username: YOUR_BITBUCKET_USERNAME # username, NOT an email
      appPassword: YOUR_APP_PASSWORD
```

**Build and push.** A Rancher cluster cannot see a locally built image, so it
has to go through a registry and be referenced by its full name in
`portal.yaml`.

```bash
yarn install --immutable
yarn tsc
yarn build:all        # build:all, NOT build:backend -- the frontend has to be
                      # compiled first or the bundle carries no app to serve
yarn build-image

docker tag backstage registry.example.com/demandai/fleet-portal:$(date +%Y-%m-%d)
docker push registry.example.com/demandai/fleet-portal:$(date +%Y-%m-%d)
```

## Apply

```bash
kubectl apply -f k8s/postgres.yaml
kubectl -n fleet rollout status statefulset/postgres

kubectl apply -f k8s/portal.yaml
kubectl -n fleet rollout status deployment/fleet-portal --timeout=6m
```

`k8s/ingress.yaml` is deliberately not in that list. Read its header first —
there is no access control on the productivity data yet.

## Verifying the running app

Work down this list. Each step rules out a different failure, and the order
matters: a later check is meaningless if an earlier one has not passed.

**1. The pod is Ready, not merely Running.** This is the distinction that
matters most here, because a misconfigured portal sits `Running` with zero
restarts for ever.

```bash
kubectl -n fleet get pods -l app=fleet-portal
# READY must read 1/1. "1/1 Running" is healthy;
# "0/1 Running" with 0 restarts is the hang -- go to step 2.
```

**2. Every plugin started.** One failed plugin does not stop the others, and
the portal will serve pages regardless.

```bash
kubectl -n fleet logs deployment/fleet-portal | grep -i "threw an error during startup"
# Expect NO output. Any line here names the plugin that failed and why.

kubectl -n fleet logs deployment/fleet-portal | grep -i "Plugin initialization complete"
# Expect all ten: app, auth, catalog, fleet, mcp-actions, permission,
# proxy, search, signals, user-settings
```

**3. The database is real.** The line to look for is the fleet plugin getting
through its own schema.

```bash
kubectl -n fleet logs deployment/fleet-portal | grep -i "migrations applied"
```

**4. The routes answer.** `401` is the correct answer for an API route with no
credentials — it means mounted and asking. `503` means that plugin never
started, and `404` means it is not mounted at all.

```bash
kubectl -n fleet exec deployment/fleet-portal -- node -e "
const p=['/.backstage/health/v1/readiness','/','/api/catalog/entities','/api/fleet/repositories'];
(async()=>{for(const x of p){const r=await fetch('http://localhost:7007'+x);
console.log(r.status, x);}})();"
```

Expect exactly:

| route                             | expected |
| --------------------------------- | -------- |
| `/.backstage/health/v1/readiness` | `200`    |
| `/`                               | `200`    |
| `/api/catalog/entities`           | `401`    |
| `/api/fleet/repositories`         | `401`    |

Do **not** use `/.backstage/health/v1/liveness` as evidence of anything: it
returns `200` unconditionally, even when every plugin has failed. For the same
reason, `/` returning 200 proves only that the frontend is served — it is a
different plugin and answers happily while the backend is dead.

**5. Data is actually landing.** A green pod is not a filled portal. The nine
scheduled passes start on staggered delays and then run every 30 minutes, so
expect the catalog to fill before the scorecard does. An empty Health Dashboard
for the first few minutes is the schedule, not a fault.

```bash
kubectl -n fleet exec statefulset/postgres -- \
  psql -U backstage -d backstage_plugin_fleet -c \
  "select 'repository' t, count(*) from repository
   union all select 'commit', count(*) from commit
   union all select 'repo_score', count(*) from repo_score;"
```

**6. Every ingestion pass is succeeding.**

```bash
kubectl -n fleet exec statefulset/postgres -- \
  psql -U backstage -d backstage_plugin_fleet -c \
  "select resource, last_success_at, consecutive_failures, last_error
   from sync_state order by resource;"
```

A row with an attempt timestamp but **neither a success nor an error** is a
task killed from outside, not one that failed — an external timeout never
reaches the service's own catch.

**7. In the browser.** Port-forward, open, sign in with **Enter** (guest), and
check the three pages: Catalog lists repositories, the Health Dashboard shows a
band bar and a Status column, and a repository page renders its scorecard.

```bash
kubectl -n fleet port-forward svc/fleet-portal 7007:7007
# http://localhost:7007
```

## Redeploying after a code change

The image carries compiled output, so a source edit needs a rebuild and a new
tag, then:

```bash
kubectl -n fleet set image deployment/fleet-portal \
  backstage=registry.example.com/demandai/fleet-portal:<new tag>
kubectl -n fleet rollout status deployment/fleet-portal
```

A task's schedule survives the restart — `next_run_start_at` is persisted per
plugin database — so a change that depends on fresh ingestion can sit invisible
for up to 30 minutes. To force a pass, set that column to `now()` for the task.

## Teardown

```bash
kubectl delete namespace fleet
```

The PVC comes from the StatefulSet's `volumeClaimTemplate` and is **not**
removed with the StatefulSet alone; deleting the namespace is what reclaims the
8Gi.
