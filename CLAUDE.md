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
| Progress        | 26 steps done, 588 tests, 34 suites, 3 e2e                   |

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
- **Environment names are inconsistent** across repos: `dev`, `Dev`,
  `development`, `staging`, `Staging`, `production`, `Production`, `Test`. No
  repo uses `QA`. The document's Development/QA/Staging/Production list does not
  match reality. **No custom normalization layer is needed**: every deployment
  record carries `environment.environment_type.name`, which Bitbucket itself
  constrains to **Test / Staging / Production**.
- **The Deployments API works.** An earlier note here said it returned nothing;
  that was one unrepresentative repository generalised into a claim, and it was
  wrong. Measured 2026-08-24: **1,328 records across 27 of 47 repositories**
  sampled; the portal stores the 50 most recent per repository, **541 rows
  across 27 repositories**, ingested and verified 2026-08-24. Bitbucket creates
  a record only when the `deployment:` value in
  `bitbucket-pipelines.yml` **exactly matches** a configured environment name,
  case included -- `oxp-backend` declares `dev`/`staging`/`production` against
  environments `Test`/`dev`/`Staging`/`Production` and so records only `dev`.
  A repository with no records almost always has a naming mismatch, not an
  absence of deployments. States seen: `COMPLETED`, `UNDEPLOYED`.
- **Bitbucket returns no `X-RateLimit-*` headers**, so quota consumption cannot
  be observed from responses. The client must count its own requests.
- **No repository had an open PR** at time of sampling (1 across 20). Historical
  merged PRs exist in volume, so PR metrics have signal -- but "PR backlog" and
  "pending approvals" will not discriminate between repos.
- A full estate sweep costs roughly **500 requests**, not 60,000.
- **Commit email is not a person.** 18 derived Users came out of 22 candidate
  authors, and two of them -- `prashant.chaudhari` and `prashantchaudhari` --
  are the same human committing under two addresses. Only a real directory can
  merge them; `examples/org.yaml` already declares `sahilotavanekar`, which a
  commit from `sahil.otavanekar@` would duplicate the same way.
- **Ownership is derivable for a quarter of the estate.** Measured 2026-08-24
  from stored commits, no API cost: **22 of 95** repositories have a committer
  holding an outright majority of the last 90 days' attributable commits, **19**
  have contributors but no clear leader, and **54** have no commits in the
  window at all. Only **10 distinct people** are proposed across those 22 --
  ownership is concentrated far more tightly than 95 repositories suggests.
  Bitbucket pipeline bots (`@bots.bitbucket.org`, 22 commits, all in
  `oxp-backend`) are excluded; no repository is currently bot-led, but one
  could be.
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
- **Unexplained flake, now worked around:** `plugin.test.ts` used to assert the
  `sync_state` primary key _behaviourally_, by inserting a duplicate and
  expecting a rejection. In the full-repo run that failed roughly one run in
  four with "Received function did not throw", and passed every time it was run
  alone, with diagnostics added, or wrapped in a single transaction -- so the
  connection-pool theory was wrong and the cause is still unknown. The DDL does
  contain `primary key (resource)`. The test now asserts that DDL instead, which
  is deterministic. If the behavioural form is ever reinstated, expect the
  flake back.
- **Never edit a migration that has already run.** Knex records migrations by
  filename, so an edit is silently a no-op against any database that already
  applied it -- the unit tests still pass, because they migrate a fresh
  database every time, and only the live run fails. This cost a debugging cycle
  on `20260824b_ownership.js`, where two columns added after the first run left
  41 repositories failing with `column "is_proposed" does not exist`. Add a new
  migration instead; the only exception is one that has never left this
  machine, which can be dropped from `knex_migrations` and re-applied.
- **Never assert a wall-clock budget in a test.** The same build and page
  measured warm medians from 0.9s to 2.8s on this machine depending only on
  what else was running. `packages/app/e2e-tests/performance.test.ts` prints
  timings and asserts **request counts** instead, which do not move with load
  and are what actually break at scale.
- **Deployments are only fetched for repositories that have pipeline runs.**
  Bitbucket cannot record a deployment without one, so asking would spend a
  request per repository to learn nothing. `RepositoryDetailIngestionService`
  guards on `runs.length > 0`; a test pins it.
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
- **Ownership resolution sits behind `OwnershipResolver`**, and there are now
  three: `PermissionOwnershipResolver` (repository admin), then
  `CommitHistoryOwnershipResolver`, chained by
  `CompositeOwnershipResolver`. Entra becomes a fourth at the front of the list.
- **Commit history is ingested in full, not windowed.** Changed in step 26: the
  first pass reaches back through everything. **Actual measured cost: 3,654
  commits in 115 requests** for the whole estate, paid once -- the incremental
  watermark keeps every later pass at 95 requests. (My pre-build estimate of
  ~18,700 commits / ~344 requests was 5x too high: it extrapolated from a
  sample weighted towards the busiest repositories. The real mean is 38 commits
  per repository, not 197.) History reaches back to **2024-11-29** and reveals
  **30 lifetime authors** against 22 in the 90-day window. The original 90-day bound was a guess
  about quota that measurement disproved, and it cost the portal the ability to
  tell an abandoned service from a two-commit scaffold (`chat-widget` has two
  commits in its whole life, `common-ui` seven).
  **Deeper history changes no score** -- verified, not assumed: all 95 scores
  were snapshotted, the estate re-scored after the backfill, and **not one of
  the 95 moved**. Every metric windows explicitly through `activitySince` and
  friends, and `CommitStore.count` is used nowhere in production. `lifetime()`
  exposes the all-time facts separately.
- **A backfill only reaches repositories with nothing stored.** `since = known
?? windowStart`, so a repository already holding commits resumes from its
  watermark and never acquires older history. Deepening the window therefore
  needs `DELETE FROM commit` before the pass, or 47 of 95 keep only what they
  had -- which is exactly what happened on the first attempt.
- **Commit figures describe the default branch only.**
  `CommitIngestionService` passes `branch: repository.default_branch`, so every
  commit count, contributor count and last-commit date excludes unmerged
  feature branches. Verifying against the repository-wide `/commits` list
  therefore reports a false difference for any repository with an active side
  branch -- that produced 21 phantom failures once. Compare against
  `/commits/{default_branch}`.
- **Verified 2026-08-25 against the live API, all 95 repositories** (190
  requests): newest commit hash and date matched on 47 of 47 where both sides
  hold commits, branch counts matched 95 of 95, and all 48 repositories shown as
  dormant genuinely have no default-branch commit inside the window. Eight
  internal consistency checks clean. The API serves complete facts for 95 of 95.
- **Admin permission beats commit history, and it is not close.** Measured
  2026-08-25: where both sources have an answer they **disagree in 18 of 26**
  repositories. `oxp-backend` -- Brijesh Gupta wrote 187 of 214 commits; the
  admins are Sreenivas Dasam and Avinash More. Coverage went from **22 to 75 of
  95** proposed owners. `GET /repositories/{ws}/{slug}/permissions-config/users`
  **works with the current token**; 68 repositories have exactly one admin, 10
  have several, 17 have none.
- **Permissions carry no email.** `GET /2.0/users/{account_id}` is **403**
  without `read:user`, so `AuthorIndex` joins a display name to a commit
  author's address on a normalised name. 14 of 16 admins match; all 75 live
  proposals ended up with an address. It is string matching, not identity --
  Entra is what makes it real.
- **Evidence must match its source.** The annotation said "9 of 208 commits" for
  an owner chosen by admin permission, which reads as an absurd justification
  for a claim that does not rest on commits. `describeEvidence` now phrases it
  per source.
- **Three ownership endpoints are closed to this token:** workspace-wide
  permissions (would be 1 request instead of 95), `branch-restrictions`, and
  `/2.0/users/{id}`. Also checked and useless here: `default-reviewers` is empty
  on every repository, and no repository ships a `CODEOWNERS` file.
- **Derived owners DO reach `spec.owner`, tagged `unconfirmed-owner`.**
  Reversed in step 20 at the product owner's direction, because every stock
  catalog surface -- Owner column, Owner filter, Owned tab, entity header,
  search facets -- reads `relations.ownedBy` and nothing else, and the catalog
  table's columns are not configurable in the new frontend system. The guards
  that make it honest: the `unconfirmed-owner` tag (so "still a guess" is one
  filter), `fleet.backstage.io/ownership-source` and `-evidence` annotations,
  and **the ownership scorer still refuses to award points for a proposal**.
  73 of 95 remain `group:default/unowned`.
- **`fleetDatabaseClient` must open exactly one pool per process.** It is
  memoised for that reason. Before it was, every call built its own
  `DatabaseManager`, so the catalog module and the search module each opened a
  pool on top of the fleet plugin's own -- three pools to one database where
  every other plugin has one. Backstage initialises fifteen plugins
  concurrently, and that was enough to starve the **catalog** plugin's
  `core.auth` service: it failed with `KnexTimeoutError: Timeout acquiring a
connection`, which took `/api/catalog` down to 404 and left every page in the
  portal unable to load an entity, while `/api/fleet` and `/api/search` kept
  answering 200 and hid the problem. Symptom to recognise: readiness returns
  503 "Backend has not started yet" while some plugin APIs still work.
- **Cross-plugin database reads go through `fleetDatabaseClient`.**
  `coreServices.database` is scoped to the asking plugin, so a module
  registered under `catalog` or `search` gets that plugin's database, not
  fleet's. The helper wraps `DatabaseManager.forPlugin('fleet')` -- the same
  connection the fleet plugin uses -- and is **read-only by contract**: fleet
  owns those migrations, and every consumer must tolerate the tables not
  existing yet.
- **Approval is not review, in this estate.** Measured 2026-08-25 from 243
  approved merged PRs: median time from opening to first approval is **12
  seconds**, and **169 of 243 (70%) are approved within five minutes**. p90 is
  3.8 hours and the tail reaches 10 days, so real review does happen on a
  minority. Treat "approved" as a weak signal; the `codeReviewCompleted` scorer
  counts approvals and therefore measures ceremony as much as scrutiny.
- **`updated_on` is not a merge time.** It moves on any later edit.
  `oxp-backend#98` merged 38 seconds after opening but was last updated four
  minutes after -- a sevenfold overstatement. `closed_on` is the real thing and
  is populated on every merged PR sampled; `first_approval_at` comes from
  `participants.participated_on`, present on all 122 of 177 sampled PRs that
  carried an approval.
- **A cancelled pipeline run is not a failed one.** `STOPPED` and `EXPIRED`
  runs are counted separately and excluded from the success-rate denominator.
  Until step 23 they were lumped into `failed` and scored as failures, which
  penalised the 16 repositories that cancel superseded builds -- 27 of the
  estate's 637 finished runs. `PipelineSummary.judged` is the honest
  denominator; `completed` includes cancellations.
- **Never derive a measurement window from `Date.now()`.** The ownership
  resolver did, so the window it _reported_ drifted from the window it
  _queried_ whenever the caller's `now` was not that instant. It passed for a
  day and broke when the date rolled over. `windowDays` is a parameter now, and
  a test pins it.
- **The classifier claims only what the evidence carries.** `spec.type` and
  `spec.lifecycle` were hardcoded `service` / `unknown` on all 95 repositories
  until step 22. Now derived: a front-end framework wins over Docker (most
  front ends here are containerised too, so letting Docker decide would call
  every one of them a service); a deployment record proves a deployed thing
  whatever the manifests say. **Never `library`** -- nothing distinguishes a
  library from an abandoned service, and 48 repositories have no CI at all.
  **Never `deprecated`** -- a quiet repository is not a retired one. Both fall
  back to `unknown`, and `unknown` in the map is distinguishable from absent
  (not yet classified), which keeps the placeholders.
- **A collator must batch.** `FleetRepositoryCollatorFactory` issues four
  queries for the whole estate; a test asserts the query count and fails on an
  N+1 (verified: an accidental per-repository call took it from 4 to 34). This
  is invisible at 95 repositories and ruinous at the 10,000 the document
  imagines.
- **A proposal only becomes the owner if it resolves to a real entity.**
  `CommitAuthorEntityProvider` emits a `User` per ownership candidate, tagged
  `derived-identity`; without one the Owner column renders a broken link, which
  reads as a defect rather than the gap it is.
- **A proposal records whether it was confident, rather than letting readers
  re-derive it.** The thresholds are configurable, so anything re-deriving the
  decision disagrees with the pass that made it the moment they are tuned.
  `ownership_candidate.is_proposed` is that record.
- **A tie is never an owner.** Two people on half the commits each clear a 50%
  share threshold; the resolver additionally requires the leader to be strictly
  ahead of the runner-up. Three tests fail if that rule is removed.

## Commands

Measure the page-load requirement (needs a production build; the backend
serves it once `packages/app/dist` exists):

```bash
yarn build:all
PLAYWRIGHT_URL=http://localhost:7007 yarn test:e2e performance
```

Browse the databases in a UI at **http://localhost:8080** (Adminer; server
`postgres`, user/password `backstage`). Development only -- it is bound to
loopback and authenticated by nothing but the Postgres credentials.

```bash
docker compose up -d          # start Postgres and Adminer
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
| 9   | §9 numbering gap  | **Not a requirement** — confirmed by the product owner; do not track it        |

### Open

|     | Question                                                          | Blocks                            |
| --- | ----------------------------------------------------------------- | --------------------------------- |
| 2   | Score band thresholds (Healthy / Needs Attention / Critical)      | Ship provisional values in config |
| 3   | Is §6 health and §7 scorecard one score or two?                   | Scoring design                    |
| 5   | Keep or drop lines added/deleted                                  | Productivity dashboards           |
| 6   | Who may see whose productivity data                               | Productivity dashboards           |
| 7   | Business Owner / Business Unit source of record; retention period | Ownership fields                  |

### Deferred as later add-ons

Productivity dashboards (§8), Business Owner/Unit fields, security-scan and
README scorers, Entra ID + RBAC.

## Known risks

- **Deployment coverage is partial and not in the portal's control.** Roughly
  half the repositories with pipelines record no deployments because their
  `deployment:` values do not match their configured environment names. The card
  says so explicitly rather than showing a blank, but closing the gap needs a
  one-line change in each affected repository, by its own team.
- Bitbucket returns no rate-limit headers, so the client must track its own
  request count. Quota is not the dominant constraint at 95 repositories, but
  the accounting should exist before the estate grows.
- **The 2-second page-load requirement is not signed off.** Server timings are
  stable and far inside budget (p95 <= 147ms on every endpoint). Browser
  timings on a developer machine swing too far to certify either way. One run
  against a deployed instance is still owed; the harness exists for it.
- Test coverage in this repo is currently near zero. New modules ship with tests.
- The Bitbucket credential in use belongs to an individual, not a service
  account. Synchronization will break if that person's access changes.

## Working agreement

Development is deliberately incremental: understand, plan, ask, implement one
small step, test, verify, report. Do not assume requirements, schemas, APIs,
credentials or behaviour that has not been confirmed. Distinguish clearly
between **verified** and **not yet verified**. Ask before architectural or
irreversible changes. Do not commit or push unless asked.
