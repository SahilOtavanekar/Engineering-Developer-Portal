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
| Scorecard       | 8 metrics, all live — 100 of 100 weight registered           |
| Progress        | 29 steps done, 689 tests, 41 suites, 4 e2e                   |

## Measured facts about the estate

Measured 2026-08-20 by a read-only recon spike (104 requests). **These supersede
the figures in the requirements document, which are wrong by roughly two orders
of magnitude.**

**The estate is live and grows.** 95 was the count on 2026-08-20; `exp` appeared
on 2026-08-27, taking it to **96**. Figures below are the original measurement,
not a running total -- check the database rather than trusting the number here.

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
- **To hide a page from the sidebar but keep it routable, take it in
  `Sidebar.tsx` -- do not disable the extension.** `nav.take('page:<id>')` and
  discard the result, as `page:search` and `page:notifications` already do.
  `app.extensions: [- page:x: false]` **is** supported (see
  `readAppExtensionsConfig` in `@backstage/frontend-app-api`; this corrects an
  earlier note here claiming no such override exists), but it deletes the
  route, and any card resolving that route ref through `useRouteRef` then
  **throws** rather than degrading. That is what
  `entity-card:catalog-graph/relations` does: disabling `page:catalog-graph`
  put `No path for routeRef{id=catalog-graph.catalogGraph}` on every entity
  page. Disabling the extension is right only when nothing else references it.
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
- **A third-party plugin's hardcoded strings are changed through its
  translation ref, not through config.** The user-settings plugin renders
  "Backstage Identity" on Settings > General; that text lives in
  `userSettingsTranslationRef`, so no `app-config.yaml` value and no
  `extensions:` override can reach it. `packages/app/src/modules/i18n` supplies
  replacement messages via `TranslationBlueprint`, which is documented as
  limited to the app plugin -- so the module registers under `pluginId: 'app'`,
  as the nav and auth modules do. Leave `full` unset: a partial override keeps
  the plugin's wording for every key not listed, where a full one must restate
  every message and renders blank for any the plugin adds later. The keys are
  type-checked against the ref, so a typo fails `yarn tsc` rather than silently
  doing nothing. Grep `packages/app/dist/static/*.js` for the new wording to
  confirm it actually shipped.
- **The brand asset lives in `packages/app/src/assets/demand-ai-logo.png`, not
  `public/`.** It is `import`ed by `LogoFull`/`LogoIcon` rather than referenced
  by URL, because `index.html` templates its asset paths through
  `<%= publicPath %>` -- a hardcoded `/demand-ai-logo.png` breaks as soon as the
  portal is served from anywhere but the domain root, and an import also gets
  fingerprinted for cache-busting. Replace the artwork by overwriting that file.
  The artwork is the mark only (137x124, a fully opaque `#12665E` tile, no
  wordmark), so `LogoFull` sets the name as text beside it; that text takes
  `palette.navigation.selectedColor` rather than a hardcoded white, which is
  what makes it correct on the light theme's `#171717` sidebar and the dark
  theme's `#424242`. **Both sidebars are dark** -- verified in
  `@backstage/theme`'s palettes, not assumed.
- **`packages/app/public/index.html` is a lodash template, and Prettier breaks
  it.** Prettier wraps the long `<%= ... %>` expression in `<title>` across a
  newline, which splits a JavaScript string literal, and
  `html-webpack-plugin` then fails the whole app build with
  `SyntaxError: Invalid or unexpected token`. The file is in `.prettierignore`
  for that reason -- do not format it, and do not remove the entry.
- **`yarn tsc`, `yarn lint:all` and `yarn prettier:check` do not compile
  `index.html`.** All three passed clean while the app could not build at all.
  Anything touching `packages/app/public/` or an imported asset needs
  `yarn workspace app build`, which is the only check that compiles the HTML
  template and resolves asset imports. Verify the built output too, not just the
  exit code: `packages/app/dist/index.html` should carry the resolved
  `<title>`, and an imported asset should appear fingerprinted in
  `dist/static/` (e.g. `demand-ai-logo.5af355a2c0a9.png`).
- **The browser icons are generated, not hand-cut.**
  `packages/app/scripts/generate-icons.py` rebuilds `favicon.ico` (16/32/48),
  `favicon-16x16`, `favicon-32x32`, `apple-touch-icon` (180),
  `android-chrome-192x192` and `safari-pinned-tab.svg` from the same source
  artwork. Re-run it after replacing the artwork; the outputs are committed and
  nothing at build time depends on the script.
  **Small sizes are optically tuned, not merely downscaled** -- thin white
  strokes average towards the background when resampled, so a straight
  downscale of this mark is an illegible smudge at 16px. Each size gets its own
  crop tightness and a stroke dilation applied at 8x supersample. 180 and 192
  take the brand's own proportions untouched. **16px is legible but no more
  than a suggestion of the mark**; that is a limit of 137x124 line art, not of
  the resampling, and higher-resolution artwork is what would fix it.
  Pillow's ICO writer downsamples one image, which would discard the per-size
  tuning, so the `.ico` container is assembled by hand with a PNG per entry.
  Safari's mask icon must be vector, so the stroke mask is thresholded and
  emitted as 218 merged rectangles.
- **Pin a logo's aspect ratio twice.** `height` with `width: auto` on an `img`,
  _and_ `objectFit: 'contain'` so a parent that forces a width letterboxes
  instead of stretching. The scaffolded `SidebarLogo` pinned both its row and
  its link to `sidebarConfig.drawerWidthClosed` (72px) whatever the drawer was
  doing, so the expanded logo was laid out in a 72px box and relied on
  overflowing it -- which is what visibly distorted it. The widths track the
  drawer (`width: '100%'`) now.
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
- **`OWNERSHIP_SOURCE_REGISTER` lives in `fleet-common`, not the backend.** Four
  places must agree on that string and they cannot import from one another: the
  resolver that writes it, the entity provider that decides whether to tag
  `unconfirmed-owner`, the scorer that decides whether to award the metric, and
  `RepositoryFactsCard`, which decides whether to call the owner a guess. The
  backend's `ownership/types.ts` re-exports it.
- **The "Repository activity" card must not call a confirmed owner a guess.**
  Its ownership block said "Suggested owner — not confirmed" and "a guess -- this
  repository is still owned by `group:default/unowned`" for _every_ proposal.
  Once the register landed that was false for 89 repositories, on both counts.
  It now branches on `isConfirmedOwnership(source)`: confirmed reads "Owner —
  confirmed" and never leads with a commit share, because that owner does not
  rest on commits -- the share appears only as corroboration, and only when it
  is non-zero. Derived owners keep the old caveat verbatim.
- **The security-scan metric is gone and the weights total 100 again.** Dropped
  at the product owner's direction on 2026-08-26; the freed 5 points plus 5 taken
  from `codeReviewCompleted` (15 -> 10) fund `pullRequestDiscipline` at 10, so
  the eight registered scorers are **20 / 10 / 20 / 10 / 10 / 10 / 10 / 10 = 100**
  and a test asserts that sum. Code review lost the five because approval is the
  weaker signal here -- median time from opening to first approval is **12
  seconds** -- where whether a change went through a pull request at all is not.
  **Section 7's security-scan requirement did not disappear with the metric**;
  the portal simply no longer tracks it, and nothing now reports that gap.
- **`availableWeight < nominalWeight` no longer means the portal is
  unfinished.** Every registered metric has a data source, so a short
  denominator now means _this repository_ has nothing to measure -- no pipeline
  runs, no merged pull requests, no commits on its default branch in the window.
  The card's wording was changed accordingly; the old "not yet wired up" text
  would send a team hunting a portal gap that no longer exists. `unmeasuredScorer`
  is kept, unused, as the mechanism for the next deferred metric.
- **Direct commits to the default branch are measured from the first-parent
  chain, not from commit counts.** At a merge the first parent is where the
  branch already was and the second is what was merged in, so everything
  reachable by following first parents is the branch's own history and
  everything else arrived inside a merge. On this estate **1,156 of 1,743
  commits in 90 days arrived inside a merge**, so a rule that skipped the walk
  would overstate direct commits threefold. `commit.arrival` records the verdict
  per commit -- `pull-request`, `direct`, `direct-merge` or `merged-in` -- so any
  reporting window is a query rather than a refetch.
  Verified 2026-08-26 against an independent read-only probe that was itself
  checked against Bitbucket's `commit/{sha}/pullrequests` endpoint on 20 of 20
  sampled commits: the portal reproduces it **exactly** -- 205 via pull request,
  365 direct, 15 direct merges, 33 repositories flagged over 90 days; 16 direct
  across 8 repositories over 30.
- **`merge_commit.hash` is ABBREVIATED to 12 characters** while commit hashes are
  full 40-character SHAs. The join must be on a prefix. Matching them whole does
  not fail -- it reports **every** commit as direct, which is plausible enough to
  ship. It happened twice: once in the probe, and once in production, where the
  first classification pass produced 1,031 direct commits and **zero** via pull
  request.
- **Two backfills were needed, and neither could be skipped.** `commit.parents`
  and `pull_request.merge_commit_hash` are both filled from data Bitbucket
  already returns, but ingestion works from watermarks (`since = known ??
windowStart` for commits, `updated_on` for pull requests), so existing rows
  never acquire them. `plugins/fleet-backend/scripts/backfill-commit-parents.js`
  (3,558 commits, 105 requests) and `backfill-pr-merge-hashes.js` (324 pull
  requests, 48 requests) fill them **in place**. Deliberately not
  `DELETE FROM commit` + re-ingest: that reaches the same state but leaves a
  window with no commits, and a scoring pass firing inside it would write a row
  of near-zero scores -- score history is append-only and cannot be corrected.
- **Classifying with no merge hashes is worse than not classifying.**
  `BranchPolicyService` skips a repository that has merged pull requests but no
  merge hashes stored, and separately skips one with any commit missing parents
  -- partial parent data stops the walk at the first gap and understates the
  mainline. A repository with genuinely no pull requests is a different case and
  is measured normally.
- **The discipline metric uses a 30-day window, not the 90 the others use.**
  Direct commits fell from **7.8 a day to 0.38 a day around 2026-07-27** while
  pull requests into main rose from 1.1 to 5.4 a day -- a branch restriction was
  evidently applied and is roughly 90% effective. At 90 days the metric reports
  380 commits across 33 repositories, most of it already-fixed history; at 30
  days it reports 16 across 8, which is the live problem.
  `fleet.scoring.disciplineWindowDays` changes it.
- **Registering the tenth metric took nominal weight to 110.** Scores still
  normalise over `availableWeight`, and the card shows the denominator, but every
  score shifted again. Rebalancing to keep 100 is a config change and a product
  decision, not a code one.
- **The catalog tag and the fleet filter are different surfaces.**
  `direct-commits-to-main` on the entity filters the **catalog** page;
  the **fleet dashboard** reads `/api/fleet/overview` and needed
  `FleetRepositorySummary.directCommits` plus a chip in `FleetFiltersBar`. Adding
  a tag does nothing for the fleet page -- that mistake was made here first.
- **The ownership metric is earned only by a confirmed owner.** `owner-assigned`
  was an `unmeasuredScorer` forfeiting 10 weight; it now scores, taking the
  scorecard from 85 to 95 of 100 measurable. **A derived owner earns zero, not
  partial credit** -- the portal can name a likely owner for nearly every
  repository, and if a guess scored, the estate would report as owned while
  nobody had agreed to own anything.
  **The two absences in `ScorerContext.ownership` mean different things and must
  not be conflated:** no `RepositoryOwnership` at all means no pass has ever
  succeeded, so the metric is _unmeasured_; a `RepositoryOwnership` with no
  `proposed` means a pass ran and found nobody, which is a real _zero_. The
  candidate rows cannot tell these apart, because a repository with no owner
  stores none -- so `ScoringService` reads the `ownership:{workspace}` sync state
  to decide. Without that, a first boot would score all 95 repositories zero on
  ownership and misreport every one of them.
  **Measured live on the pass at 09:15:26 on 2026-08-26, and it matched the
  projection exactly: 89 scores up, 4 down, 2 unchanged; bands healthy 32 to 36,
  needs-attention 14 to 17, critical 49 to 42**, all 11 band changes
  improvements. 89 repositories earn the metric, 6 score zero, none is
  unmeasured. `available_weight` moved 50/65/70/85 to 60/75/80/95.
  **The 6 scoring zero are almost exactly the repositories the document does not
  cover** -- `dds-dai-delivery`, `demand-ai-website`, `email-delete-handler` and
  `milestone-mockups` are missing from it entirely, and `ux-designs` has "-" as
  its owner. The metric is pointing at the real gap.
- **`available_weight` is per repository, not a constant.** It is 50 for 45
  repositories, 65 for 3, 70 for 9 and 85 for 38, because `readmeAvailable` and
  others return `null` where their data has not been fetched. Any arithmetic on
  scores must read each repository's own weight -- assuming a fleet-wide 85
  produced a projection that showed confirmed repositories _losing_ points,
  which is impossible.
- **Ownership is confirmed from a register, not inferred.** The repository
  standardization document (`Bitbucket repository standardization.pdf`) is the
  authority, transcribed to `catalog/ownership-register.yaml` and read through
  `fleet.ownership.register`. `RegisterOwnershipResolver` sits **first** in the
  chain and its answers are _confirmed_: they carry `confirmed-owner` instead of
  `unconfirmed-owner`, and the evidence annotation says a person wrote it down.
  Measured 2026-08-26 after the change: agreement with the document went from
  **54 to 87 of 91** matched repositories, the 18 repositories where the
  document named an owner and the portal had none went to **0**, and the catalog
  went from **0 confirmed / 76 unconfirmed / 19 unowned** to **89 confirmed /
  5 unconfirmed / 1 unowned**. The register costs no Bitbucket requests, and
  because it answers first the permission resolver is no longer called for those
  89 repositories -- the pass got cheaper, not dearer.
  Edit the YAML and restart; no deploy, no migration.
- **Neither inference was the authority it was taken for. This corrects an
  earlier claim here that "admin permission beats commit history, and it is not
  close."** That compared the two sources _against each other_ with no ground
  truth. Measured against the document: admin permission agreed on **47 of 62
  (76%)**, commit history on **7 of 9 (78%)** -- indistinguishable, and the
  commit-history sample is too small to separate them anyway. `oxp-backend` is
  the case that settles it: commit history said Brijesh Gupta (187 of 214
  commits), admin permission said Avinash More, and the document says the owners
  are Brijesh, Sanjay and Vivek. **The inference we chose to trust was the wrong
  one.** Both stay in the chain, behind the register, because between them they
  still answer for the repositories nobody has written down -- but neither may
  be described as authoritative.
- **The register names people by first name, and one of them is ambiguous.**
  `Shubham` on `website-tracking` could be Subham Jain or Shubham Sharma; the
  document does not say. An owner name with no `people` entry produces **no
  candidate rather than a guess**, so that repository is owned by Vivek
  Mangukiya alone. Do not "fix" this by picking one.
- **`GET /repositories/{ws}/{slug}/permissions-config/users` works with the
  current token**; 68 repositories have exactly one admin, 10 have several, 17
  have none. Where both sources have an answer they **disagree in 18 of 26**
  repositories.
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
- **The document covers 96 repositories, not the 97 it claims, and the estates
  do not quite match.** `dai-finance tracker` and `dai-finance-tracker` are one
  repository listed twice with contradictory comments. Five repositories it
  names (`entitlements-backend`/`-frontend`/`-sdk`,
  `onboarding_backend`/`_frontend`) **do not exist in the `demandai`
  workspace at all** -- not stale, absent -- which most likely means a second
  Bitbucket workspace, invisible because workspace enumeration returns 410
  (CHANGE-2770). They sit commented out at the end of the register. Four
  repositories we hold are missing from the document, including
  **`demand-ai-website` at 288 commits**. Its "no commits" comments are also
  loose: `campaign-report-generator`, `content-tools` and `ux-designs` each hold
  exactly one.
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

- **The problem derivation lives in `fleet-common`, because both sides need
  it.** The fleet overview endpoint and the repository card both classify
  problems, and two implementations would eventually disagree about what is
  wrong with a repository. `plugins/fleet-common/src/problems.ts` is the single
  one; the router imports it exactly as the card does.
  **The overview sends a compact summary, not the breakdown.** 96 repositories
  times eight metrics with detail _and_ remediation strings would add tens of
  kilobytes to the one endpoint the two-second page load depends on, and that
  requirement is already unsigned-off. `FleetRepositorySummary.problems` carries
  only `{id, title, lost}[]`, a total, and the dormancy kind -- what a list needs
  to count, rank and filter. Full text stays on the repository page.
  Dormancy classification needs lifetime commit counts, so
  `CommitStore.lifetimeCommitsForWorkspace` is one query for the estate; a
  per-repository lookup would be an N+1 in precisely the wrong endpoint.
  **There are two `ScoreBreakdownEntry` definitions** -- one in
  `fleet-backend/src/scoring/types.ts` that the engine writes, one in
  `fleet-common` that the frontend reads. Adding `remediation` to only the
  second compiled fine, because an object spread bypasses excess-property
  checking, and then failed at the first property access. Keep them in step.
- **Remediation text belongs to the scorer, not to whatever renders it.**
  `ScorerOutcome.remediation` is optional and each of the eight scorers supplies
  its own, because the fix almost always quotes a **configured** value -- the
  commit target, the discipline window -- and a frontend lookup table would
  duplicate config and drift silently the moment someone tuned it. A test proves
  it: `activeCommitsScorer({ target: 25 })` says "25 commits in 90 days", not a
  hardcoded 10.
  The engine drops remediation at full marks, so it never travels beside a
  metric that lost nothing. Two scorers deliberately stay **silent**:
  `activeCommits` and `activeContributors` say nothing to a repository with no
  commits at all, because "commit more" answers neither the scaffold case nor
  the abandoned one -- the card reports that as dormancy instead.
  **Adding the field broke four pre-existing tests** that used `toEqual` on
  outcomes and breakdown entries. They are `toMatchObject` now; exact equality
  on a growing object makes every future field addition look like a regression.
  Breakdowns are stored as JSON, so scores computed before this simply lack the
  field until the next pass rewrites them.
- **Highlighting problems is about classifying the repository, not ranking
  metrics.** 59 of 96 repositories score below healthy, and they are three
  unrelated populations: **42 were never really developed** (ten or fewer commits
  ever), **6 were active and stopped**, and only **11 are active but
  underperforming**. Ranking metrics by points lost and showing the worst would
  print "no commits in 90 days" 48 times, 42 of them about scaffolds -- which is
  how a warning gets trained out of people.
  So `plugins/fleet/src/problems.ts` folds `active-commits`,
  `active-contributors` and `branch-hygiene` into a single dormancy statement
  whenever the activity metric is zero: they are one fact wearing three hats,
  and a dormant repository scores zero on all three by construction. Dormancy is
  then phrased by history -- `portal-ui` with 276 lifetime commits reads
  "abandoned", a four-commit scaffold reads "never really developed. Not a
  decaying service." Absent lifetime data assumes never-started, because that is
  the less alarming of the two guesses.
  Unmeasurable metrics are listed separately and never counted as problems: 55
  repositories cannot be judged on code review at all.
  **The payoff is that the top actionable problem across the estate turns out to
  be `README available` on 29 repositories** -- minutes of work each, previously
  buried beneath four larger numbers nobody could act on. Pipeline passing is
  second at 14.
  Problems are shown only below healthy: a banner on the 36 healthy
  repositories would be noise. This is derived from the breakdown the scoring
  pass already writes -- no migration, no new pass, no Bitbucket requests -- and
  the cost of that is that the wording cannot quote a configured target, so
  remediation text is deferred rather than guessed.
- **"Register existing component" is removed, and the document was checked
  first.** All 196 paragraphs of `Engineering portal.docx` were extracted and
  searched: **zero occurrences** of register, import, onboard, catalog-info or
  self-service. The document specifies the opposite mechanism -- section 2 says
  the platform "shall **synchronize**" and that "synchronization should occur
  periodically". The only clause permitting manual entry is section 4's
  "ownership information should be synchronized from repository metadata **or
  configured manually**", which is about _ownership_ and is already satisfied by
  `catalog/ownership-register.yaml`.
  Removal was also positively better than leaving it: **0% of the estate has a
  `catalog-info.yaml`**, so the import flow had nothing to import, and an
  imported entity would arrive under a `url:` locationKey for an entity ref the
  provider already owns under `bitbucket-repositories:demandai` -- two owners for
  one entity is the conflict case locationKey exists to detect.
  Three touch points only: the `@backstage/plugin-catalog-import` dependency and
  the `catalog.import` config block, with **no source references at all** -- it
  reached the sidebar through `nav.rest()`, so no `Sidebar.tsx` edit was needed.
  Nothing of ours reads `catalog.import.*`, and the entity provider never looks
  for a `catalog-info.yaml`; it synthesises a Component unconditionally.
  **The trade-off, accepted knowingly:** there is now no way to catalog anything
  that is not a Bitbucket repository in a configured workspace except by adding
  it to `catalog.locations`. For the five repositories the standardization
  document names but the `demandai` workspace lacks, the answer is another entry
  in `fleet.bitbucket.workspaces`, not a manual registration.
- **The scaffolder ("Create...") is removed, deliberately and completely.**
  Dropped 2026-08-27 at the product owner's direction. Nine touch points: the
  `@backstage/plugin-scaffolder` app dependency, four backend packages, the
  `backend.add` calls in `packages/backend/src/index.ts`, `nav.take(
'page:scaffolder')` in `Sidebar.tsx`, the `scaffolder:` config block,
  `scaffolder` in `mcpActions.pluginSources`, the `catalog.locations` entry for
  the example template, and `examples/template/`.
  **The order was not arbitrary.**
  `plugin-catalog-backend-module-scaffolder-entity-model` is what teaches the
  catalog the `Template` kind, so the catalog location had to go **first** and
  the Template entity be confirmed gone before that module was removed --
  otherwise the catalog meets an entity of a kind it no longer understands.
  Backstage hot-reloaded the config change and dropped it without a restart.
  **The page appeared because of `app.packages: all`**, which discovers plugins
  from `packages/app/package.json`; removing the dependency is what removes the
  page, and there is no `extensions:` override that would have done it.
  `yarn install` then failed with `EPERM` unlinking `isolated-vm` -- a scaffolder
  native module the running backend still had loaded. Stop the app first.
  `plugins/fleet/src/routes.ts` was **not** touched: the warning above is about
  not deleting it during exactly this operation, and it holds the fleet plugin's
  own route ref. The `backstage_plugin_scaffolder` database is left in place;
  it is inert and dropping it buys nothing.
  Verified: 13 plugins initialise where there were 14, no errors, catalog serves
  97 Components and 0 Templates.

- **Requirement 8 delivers eight of its ten measures, and the two missing ones
  are a cost decision.** Lines added and deleted exist only behind
  `/2.0/repositories/{ws}/{slug}/diffstat/{sha}` -- verified working, returning
  real numbers -- at **one or more requests per commit**, so about 4,000 for this
  estate against ~500 for a full sweep. Open decision 5 should be settled on that
  number. **Filtering by Team has no data source at all**, not merely deferred.
- **Participants and `closed_by` cost nothing, and looked unavailable.** The
  pull request _list_ endpoint omits `participants` entirely by default; asking
  for `values.participants.user.display_name` and friends returns them in full.
  A first probe concluded they were unavailable because it used an invalid
  nested selector and the single-PR endpoint returned none for a pull request
  that genuinely had none. Same lesson as `merge_commit.hash`: the field is
  there if the selector asks.
- **Commits and pull requests identify people differently, and the register
  bridges them.** A commit carries an address and an unreliable name; a pull
  request carries a display name and an account id but **no address**, because
  `/2.0/users/{account_id}` is 403. So `ProductivityService` resolves commits by
  address and pull requests by normalised name onto one person. Measured: **332
  of 332 pull request authors matched**, and all 29 commit addresses resolve.
- **`RegisteredEngineer.email` is optional, because reviewing is not
  committing.** `Saideep Narayan Avhad` reviews pull requests and has never
  committed, so there is no address to key them on -- found by the pass
  reporting them as unattributed rather than dropping them. Requiring an address
  would have silently erased a real contributor; inventing one would later
  attribute somebody else's commits to them.
- **Anything the register cannot account for is named on the page.** An engineer
  missing from the register looks exactly like one who did nothing, and only one
  of those is worth a conversation. `ProductivityOverview.unattributed` carries
  the addresses, the names and the commits they cover.
- **Reporting periods are computed in the frontend and sent as dates.**
  `plugins/fleet/src/periods.ts` turns "this quarter" into explicit
  `since`/`until` in UTC. Two places deciding when a quarter starts is how a
  dashboard and a report come to disagree; UTC because local midnight shifts
  commits between buckets depending on who is looking.
- **Productivity has no access control yet, deliberately.** Open question 6 is
  unresolved and the portal runs `allow-all-policy`, so everyone who can read the
  fleet can read everyone's figures. The endpoint checks only
  `fleetRepositoryReadPermission`. This is per-person performance data; treat the
  gap as blocking before anyone outside the team sees the page.

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
