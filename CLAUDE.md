# CLAUDE.md

Working notes for this repository. Keep this current — it is the primary way
project context survives across sessions.

## What this is

An Internal Developer Portal built on Backstage, specified in
`Engineering portal.docx` at the repo root. It integrates **Atlassian Bitbucket
Cloud** and (later) **Microsoft Entra ID** to provide repository catalog,
ownership, health scoring, and engineering productivity insight.

Target is the organization's **real Bitbucket estate**, not a sandbox.

## Current state

|                 |                                                              |
| --------------- | ------------------------------------------------------------ |
| Backstage       | 1.53.0                                                       |
| Frontend system | **New** — `createApp` from `@backstage/frontend-defaults`    |
| Backend system  | **New** — `createBackend()`                                  |
| Node / Yarn     | 24.x / 4.13.0                                                |
| Dev database    | PostgreSQL 16 via `docker-compose.yml`                       |
| Auth            | GitHub OAuth + guest (**placeholder** — Entra ID comes last) |
| Permissions     | `allow-all-policy` — nothing is enforced yet                 |
| Custom plugins  | `fleet-common`, `fleet-backend`, `fleet` (frontend)          |
| Scorecard       | 6 of 9 metrics live — 85 of 100 weight measurable            |
| Progress        | 13 steps done, 266 tests, 20 suites                          |

## Measured facts about the estate

Measured 2026-08-20 by a read-only recon spike (104 requests). **These supersede
the figures in the requirements document, which are wrong by roughly two orders
of magnitude.**

|               | Document says | Actually measured                             |
| ------------- | ------------- | --------------------------------------------- |
| Repositories  | 10,000        | **95** (workspace `demandai`)                 |
| Commits       | 1,000,000     | ~1,150 in 90 days across the 10 busiest repos |
| Pull requests | 100,000       | 341 merged across those same 10 repos         |
| Users         | 5,000         | not measured                                  |

Other findings:

- **0% of sampled repositories have `catalog-info.yaml`.** The stock
  `BitbucketCloudEntityProvider` would register nothing at all. The custom
  enumerating provider is mandatory, not a preference.
- **40% have `bitbucket-pipelines.yml`**; 35% declare deployment environments.
- **Environment names are inconsistent** across repos: `dev`, `development`,
  `staging`, `Staging`, `production`, `Production`, `Test`. No repo uses `QA`.
  The document's Development/QA/Staging/Production list does not match reality
  and a normalization layer is required.
- **The Deployments API returns 0 records** even for a repo that declares three
  environments and has them configured. Environment status has no working data
  source today.
- **Bitbucket returns no `X-RateLimit-*` headers**, so quota consumption cannot
  be observed from responses. The client must count its own requests.
- **No repository had an open PR** at time of sampling (1 across 20). Historical
  merged PRs exist in volume, so PR metrics have signal -- but "PR backlog" and
  "pending approvals" will not discriminate between repos.
- A full estate sweep costs roughly **500 requests**, not 60,000.
- **89 of 95 repositories (94%) have no language detected by Bitbucket.** The
  "Programming Language" field required by section 3 will be blank for almost
  the whole estate unless it is derived some other way.
- Listing all 95 repositories costs exactly **one** API request.
- **Zero internal dependencies across the estate.** All 35 `package.json`,
  `requirements.txt` and `pyproject.toml` manifests were fetched and none
  reference another repository: no `git+`, no `bitbucket.org` URLs, no
  `@demandai/` scope, no `file:`/`workspace:` links. Package names mostly do not
  match repo slugs either (`dxp` -> `velzon-ts`, `common-ui` -> `apilink`).
  **Section 5 (relationship mapping) therefore has no data source** -- a
  manifest parser emitting `dependsOn` would produce an empty graph. Populating
  it needs either hand-written `catalog-info.yaml` or a decision to drop it.
- **Technology stack is derivable, and fixes the language gap.** Derived for 57
  repositories: AWS SAM 24, Node.js 19, Docker 18, AWS SDK 15, React 14,
  TypeScript 13, Python 13. Language now known for 32 of 95, up from Bitbucket's 6. Zero `pom.xml` anywhere -- the document's Java assumptions do not match.

### Deprecated endpoints -- CHANGE-2770

These all return **410 Gone** and cannot be used:

- `/2.0/workspaces`
- `/2.0/user/permissions/workspaces`
- `/2.0/repositories` (unscoped, with `role=`)

Workspace slugs therefore **cannot be discovered** and must be supplied in
config. Workspace-scoped `/2.0/repositories/{workspace}` works normally.

The current token also lacks the `read:user:bitbucket` scope, so `/2.0/user`
returns 403. Not blocking for repository work; may matter when mapping commit
authors to identities.

## Architecture decisions

### Metrics do not go in the catalog

The Backstage catalog re-stitches entities on every refresh and holds no
history. Commit counts, PR cycle times, pipeline results and health scores are
time-series data and belong elsewhere.

**Two stores, one join key:**

- **Catalog** — identity, ownership, relationships. Keyed by entity ref.
- **Plugin DB** — Bitbucket facts, rollups, scores. Keyed by the same entity ref.

Scores are computed on a schedule and read back pre-computed. Never compute a
score during a page render — that is what makes the 2-second load requirement
achievable.

### All Bitbucket access goes through one interface

A typed `BitbucketClient` interface describes what the portal needs, not what
the API returns. Two implementations: a real Cloud adapter, and a fake used by
tests. Nothing downstream imports the Bitbucket API directly.

### Scoring is a registry of independent scorers

Each metric is a self-contained, individually testable scorer. Weights and band
thresholds live in **config, not code**. This is what makes deferred metrics
(security scan, README, line counts) pluggable slots rather than refactors.

### The stock Bitbucket entity provider is not sufficient

`BitbucketCloudEntityProvider` discovers _existing `catalog-info.yaml` files_
via code search. It does not enumerate repositories. For full estate coverage we
need a **custom entity provider** that lists repositories from the API and
synthesizes a Component per repo, treating any real `catalog-info.yaml` as an
override.

## Conventions

- **New frontend system only.** Plugins use `createFrontendPlugin` and
  blueprints (`PageBlueprint`, `EntityCardBlueprint`, `NavItemBlueprint`).
  Follow the existing patterns in `packages/app/src/modules/nav` and
  `packages/app/src/modules/auth`. Most Backstage tutorials online show the
  legacy `createPlugin` + JSX routes API — that does **not** work here.
- **A page extension needs a route ref, a title AND an icon to appear in the
  sidebar.** `AppNav` discards any page missing any one of the three, silently
  and with no warning -- the page still routes and still renders when visited
  directly, it just never appears in the nav. `plugins/fleet/src/plugin.test.tsx`
  pins all three; keep that pattern for every new page.
- **Do not delete `routes.ts` when stripping scaffolder demo code.** The
  generated `routeRef` and the plugin's `routes:` block are load-bearing, not
  part of the demo.
- **Never send `Accept: application/json` when fetching raw file content.**
  Bitbucket then labels the response JSON and the reader parses plain text,
  which broke 13 repositories on `requirements.txt` and `pyproject.toml`.
  `BitbucketCloudClient` has a separate `requestText` path for this; use it.
- **Secrets never in committed files.** Real values go in
  `app-config.local.yaml` (gitignored) as plain values. Committed config uses
  `${ENV_VAR}` placeholders.
- **Define permissions as routes are built**, in the shared common package, even
  though `allow-all-policy` means nothing is enforced yet. Retrofitting
  permissions across every route later is significantly harder.
- **Score history is written from the first scorer onward** — one row per repo
  per run, never a single mutable row. History cannot be backfilled.
- Ownership resolution sits behind its own interface so the eventual switch from
  synthetic org data to Entra/msgraph is a swap, not a rewrite.

## Commands

```bash
docker compose up -d          # start Postgres
yarn install                  # install deps
yarn start                    # app :3000, backend :7007
yarn tsc                      # typecheck
yarn lint:all                 # lint everything
CI=true yarn test             # unit tests (CI=true avoids watch mode)
yarn test:e2e                 # playwright
```

Inspect the database:

```bash
docker exec -it backstage-postgres psql -U backstage -c "\l"
```

## Decisions

### Closed

|     | Decision          | Outcome                                                                        |
| --- | ----------------- | ------------------------------------------------------------------------------ |
| 1   | Bitbucket flavour | **Cloud** (Pipelines is Cloud-only)                                            |
| 4   | CI/CD system      | **Bitbucket Pipelines** — same API, same credentials, same quota               |
| —   | Dev database      | Postgres 16 in Docker; managed Postgres for production                         |
| —   | Auth sequencing   | Entra ID deferred to the **end** of the build                                  |
| —   | Config placement  | Postgres in `app-config.yaml` with `${...}`; values in `app-config.local.yaml` |

### Open

|     | Question                                                          | Blocks                            |
| --- | ----------------------------------------------------------------- | --------------------------------- |
| 2   | Score band thresholds (Healthy / Needs Attention / Critical)      | Ship provisional values in config |
| 3   | Is §6 health and §7 scorecard one score or two?                   | Scoring design                    |
| 5   | Keep or drop lines added/deleted                                  | Productivity dashboards           |
| 6   | Who may see whose productivity data                               | Productivity dashboards           |
| 7   | Business Owner / Business Unit source of record; retention period | Ownership fields                  |
| 9   | §9 is missing from the document — numbering jumps 8 → 10          | Unknown scope                     |

### Deferred as later add-ons

Productivity dashboards (§8), Business Owner/Unit fields, security-scan and
README scorers, Entra ID + RBAC.

## Known risks

- **Deployment status has no working source.** Environments are configured and
  `deployment:` keywords exist in pipeline files, but the Deployments API
  returns no records. Until that is understood, the environment view in section
  6 cannot be populated from Bitbucket alone. Fallback: have pipelines POST
  deployment events to the portal.
- **Environment naming is inconsistent** across repositories and needs
  normalization before it can drive any UI.
- Bitbucket returns no rate-limit headers, so the client must track its own
  request count. Quota is not the dominant constraint at 95 repositories, but
  the accounting should exist before the estate grows.
- Test coverage in this repo is currently near zero. New modules ship with tests.
- The Bitbucket credential in use belongs to an individual, not a service
  account. Synchronization will break if that person's access changes.

## Working agreement

Development is deliberately incremental: understand, plan, ask, implement one
small step, test, verify, report. Do not assume requirements, schemas, APIs,
credentials or behaviour that has not been confirmed. Distinguish clearly
between **verified** and **not yet verified**. Ask before architectural or
irreversible changes. Do not commit or push unless asked.
