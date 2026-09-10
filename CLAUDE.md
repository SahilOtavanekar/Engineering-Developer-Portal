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

|                 |                                                                       |
| --------------- | --------------------------------------------------------------------- |
| Backstage       | 1.53.0                                                                |
| Frontend system | **New** — `createApp` from `@backstage/frontend-defaults`             |
| Backend system  | **New** — `createBackend()`                                           |
| Node / Yarn     | 24.x / 4.13.0                                                         |
| Dev database    | PostgreSQL 16 via `docker-compose.yml`                                |
| Auth            | GitHub OAuth + guest (**placeholder** — Entra ID comes last)          |
| Permissions     | `allow-all-policy` — nothing is enforced yet                          |
| Custom plugins  | `fleet-common`, `fleet-backend`, `fleet` (frontend)                   |
| Scorecard       | **7 metrics — the requirement's own set.** All measurable, 100 of 100 |
| Bands           | **4** — Excellent 90+, Healthy 75+, Needs Attention 60+, At Risk      |
| Branches        | Divergence measured on its own 6h pass, **not scored**                |
| Progress        | 1,123 tests, 57 suites, 4 e2e                                         |
| Theme           | Custom, token-driven — `packages/app/src/modules/theme`               |

### The scorecard, as it stands 2026-09-10

The requirement's seven rules, at its weights, registered in the order its
tables list them so the document can be read beside the page. Live figures
from the pass at 05:48 on 2026-09-10, **99 repositories** -- the estate grew by
one that morning (`axp-data-plugin-user-report-daily`), which is the standing
reason to read these from the database rather than from here.

| Rule                          | Weight | Bands                | Measurable on | Notes                                           |
| ----------------------------- | -----: | -------------------- | ------------: | ----------------------------------------------- |
| Main branch up to date        |     20 | 30 / 60 / 90 days    |         99/99 | `repository.last_commit_at`, default branch     |
| Stale branches                |     15 | 0 / 1-2 / 3-5 / >5   |         99/99 | count, excludes default + `exempt`              |
| Changes through pull requests |     20 | 100% / 95 / 80       |         40/99 | 30-day window; middle bands unreachable here    |
| Code review completed         |     15 | 90% / 70%            |         45/99 | **peer** approvals; 39 repositories lose points |
| Pull request size             |     10 | <400 / ≤1000 / >1000 |         44/99 | **median** (decision 11); bottom band pays 1    |
| Active development            |     10 | 30 / 60 / 90 days    |         99/99 | newest commit on **any** branch                 |
| README available              |     10 | present / absent     |         99/99 | 64 present, 35 absent                           |

Estate bands: **1 excellent / 17 healthy / 29 needs-attention / 52 at-risk**,
mean total 53.5. `available_weight` ranges 55-100 per repository.

**Verified in the browser 2026-09-10**, every figure cross-checked against the
database: the band bar reads 52 / 29 / 17 / 1 and the Status column counts the
same, "99 repositories", and all seven problem chips match a SQL reproduction
of `deriveProblems` exactly -- code review 39, README 35, pull request size 21,
main branch 19, stale branches 19, no recent development 16, bypassing pull
requests 9. No chips for the three unregistered metrics. No sideways scroll.

**Unregistered, kept and tested:** `activeContributors`, `pipelineHealth`,
`ownerAssigned`. Each file opens with a NOT REGISTERED note; their inputs are
still populated, so reinstating one is a line in `plugin.ts` plus a weight
rebalance to keep the sum at 100.

**Where to pick up.** The six-step rewrite is complete. What is left is
judgement, not construction:

1. ~~Open decision 11~~ **CLOSED and live: median.** Chosen by the product
   owner 2026-09-10, set in `app-config.yaml`, and confirmed in the running
   portal after a backend restart -- 44 of 44 repositories scored on the
   median, 0 on the mean. **The projection held exactly**: the same four
   repositories moved, at the same totals -- `ingest-jobs` 68→77 and `crm`
   66→75 into Healthy, `website-tracking` 56→65 and `dxp-mono` 53→60 out of At
   Risk -- and the metric split landed on the predicted 23 / 8 / 13.
   The one discrepancy was in the baseline, not the change: the estate-wide
   figures were projected from a pass that was one cycle stale, during which
   an ingestion pass moved one repository on its own. **Project from the pass
   you are about to replace, not the one before it.**
2. **Open decision 8** — whether branch divergence should score at all. It
   would need a weight rebalance away from 100.
3. **§8 access control** (open decision 6) — still the one blocking gap before
   anyone outside the team sees per-person figures.
4. **Per-engineer lines added/deleted** is now nearly free; see requirement 8
   below.

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

### Measured 2026-09-01

- **Repository creators are derivable for 96 of 96.** The earliest commit's
  author, resolved through the identity register -- and all **19** distinct
  first-commit addresses were already in it, so no identity work was needed.
  Concentrated: Makarand Prabhu created 17, Pratik Nimbalkar 15, Mangesh
  Gaikwad and Mohit Sharma 12 each. **5 repositories have a first commit that
  predates the repository**, meaning imported history, and there the name is
  weak evidence -- `RepositoryFacts.createdBy.importedHistory` flags them and
  the card says "First commit by" instead of "Created by".
- **The creator is the documented owner in 63 of 95 (66%).** Both sides
  resolved through the register; raw addresses would have said 62, and the
  difference is one alias. The 32 disagreements are not scattered: Subham Jain
  scaffolded a run of `daarwyn-*` services that Mohit Sharma owns, which reads
  as a deliberate handover rather than a data problem. `repository-admin`
  agreed 6 of 6, but that is a weak result -- whoever creates a repository
  usually becomes its admin, so the two sources nearly measure the same thing.
- **Active contributors: 48 of 96 repositories, 1-5 people each** (mean 2.3),
  **107 author-repository pairs** across the estate in 90 days. Small enough
  that the whole per-engineer breakdown ships with the productivity overview --
  about 4KB -- rather than needing an endpoint per engineer.
- **Bitbucket carries a human name for each project, and half of them say
  nothing.** Probed 2026-09-08, one request: `AM` is `Amplifye`, `DDS` is
  `DAI Delivery Systems`, `RES` is `Research` -- but `DAARWYN` and `MDLH` are
  their own keys and `DAIWEB` is `DAI-WEB`. **MDLH, the largest project at 37
  repositories, expands to itself.** So a "full project name" feature reaches
  three of six, which is worth knowing before spending surface on it.
  `values.project.name` costs **zero extra requests** -- it rides the same
  projection that lists all 98 repositories in one call, the same lesson as
  `merge_commit.hash` and PR participants.
- **Every repository has a Bitbucket project**, and they map onto Backstage
  Systems with no gaps: MDLH 36, AM 21, DDS 20, DAARWYN 12, RES 4, DAIWEB 3.
  The provider now emits a `System` per project and sets `spec.system`, which
  filled a catalog column that was blank on all 96 rows at **zero API cost** --
  `project_key` had been stored since the first ingestion pass.
- **Branch divergence: 185 branches measured, 98 holding unmerged work, 2,699
  commits stranded**, 7 at the 100-commit page cap. 262 non-default branches
  exist; 77 are skipped as the source of a merged pull request.
  **Roughly 750 of those commits are on deliberate long-lived branches** --
  `stage` on 12 repositories (355), `staging` 2 (156), `dev` 6 (139),
  `dev-stage` 1 (100) -- which will never merge to main by design and inflate
  the estate figure by about 28%. Nothing filters them yet.
- **Main branch health, 30 days:** 7 repositories have work reaching main
  outside a pull request. `exp` is the worst at 12 direct commits of 13.

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

### The theme is one token file feeding three rendering layers

`packages/app/src/modules/theme/tokens.ts` is the single source of colour,
depth, shape and rhythm, in both modes. Nothing else in the portal may hold a
raw colour.

It has to be one file because the portal is **not one UI kit**, and none of the
three layers can read the others' configuration:

| layer            | where                                           | reached by                               |
| ---------------- | ----------------------------------------------- | ---------------------------------------- |
| Material UI v4   | catalog table, entity shells, sidebar, buttons  | `createUnifiedTheme` component overrides |
| Backstage UI     | every Fleet page and card, the catalog shell    | `--bui-*` custom properties              |
| hand-rolled HTML | the two Fleet tables, chips, inputs, sparklines | `plugins/fleet/src/surfaces.ts`          |

**The Backstage UI bridge is the highest-leverage part, and it has one trap.**
`@backstage/ui` declares its 152 tokens inside `@layer tokens`, so unlayered CSS
-- which `globalCss` emits -- beats them with no `!important` and no specificity
fight. But **the selector must include `body`, not just `:root`**: custom
properties inherit, so `:root` looks sufficient, and it is not. BUI's dark
tokens are declared on `[data-theme-mode='dark']`, an attribute
`UnifiedThemeProvider` sets on `document.body`, and a declaration on the element
itself always beats a value inherited from an ancestor, layer or no layer.
`:root` alone works in light and silently does nothing in dark.

Two namespaces, and the difference matters: `--bui-*` are redefinitions of
somebody else's contract and must keep their meanings; `--portal-*` are ours,
for what BUI has no token for (shadows, accent, pill radius, blur).

**Tokens are contrast-tested, not eyeballed.** `tokens.test.ts` composites every
translucent surface over what is actually behind it -- two blends deep for a
nested panel -- and asserts WCAG AA on every text/ground pair in both modes, 88
tests. It has already caught three real failures that looked fine in a mockup:
white on amber (3.6:1, so warning takes dark text where the other intents take
white), dark-mode muted text against the _popover_ surface rather than the page,
and white on the reference design's emerald button (2.5:1).

A parity test pins that both modes declare the same keys. A token present in one
mode only yields `undefined` in a custom property, which does not throw -- it
falls back to whatever BUI shipped, in one mode, and is found by a person.

**The page grounds are a four-step ladder, and until 2026-09-03 it was
inverted.** Sidebar, page header, page and card are four separate grounds that
have to descend in that order. Measured before the change, each composited over
the page: sidebar `#f9fafc`, header `#f9fafc`, page `#eef2f7`, card `#fbfcfd`.
The sidebar was **lighter than its own page** and within two units of a card --
not a faint distinction but the wrong way round, which is why it dissolved into
the content instead of reading as a region. Now 200 / 223 / 232 / 250 on the red
channel, the sidebar carrying a tint of the brand emerald so that it is
separated by hue as well as by value.

**Three things had to change together and only one of them was a colour.**

- **The header was painted from `palette.navigation.background`**, so the title
  bar and the sidebar were the same token and could not have been made to
  contrast however either was coloured. `bg.header` is its own ground now,
  reaching `PortalPageLayout` as `--portal-header-bg` -- a custom property
  rather than a palette key, because `palette.navigation` is contractually the
  keys `core-components`' sidebar reads and this is not one of them.
- **`bg.gradient` can defeat a token change.** Its white radial was
  `rgba(255, 255, 255, 0.85)` at `12% -12%`, putting roughly **49% white behind
  the header and 38% behind the top of the sidebar** -- precisely the corner
  where these grounds have to be distinguishable, and enough to half-erase any
  token edit made there. Pulled back to 0.42. Note that `tokens.test.ts`
  composites over `bg.app` alone and does not model the gradient at all; in
  light mode that is conservative for dark text, but it is a gap.
- **A ground change is an AA change, and the failures are invisible.**
  `nav.color` `#556579` measures **4.17:1** on the green sidebar and fails
  outright, so it is `#42574f` (4.94:1). The new header ground then put
  `fg.muted` at **4.487** -- under by 0.013, found by the test and by nothing
  else. Lightening the header would have bought 0.13 of contrast for 3 of the 9
  units of separation the change exists to create; darkening the palest text
  improves every ground at once (page 4.77 to 4.92, card 5.41 to 5.58) and costs
  the ladder nothing, so `fg.muted` is `#57677a`. The header is registered in
  `grounds` rather than given bespoke cases for the two foregrounds it happens
  to render today, which took the suite from 94 to 108.

**Dark mode's header is lighter than its page where light mode's is darker, and
that is the convention rather than an oversight.** Dark mode raises an elevated
surface towards the light -- `surface[3]` and the `fg.muted` note are both
already written against that fact -- and there is nowhere else to go: the
sidebar takes the darkest ground and the page is already within a few units of
black, so a header darker still would be indistinguishable from both. The
sidebar remains the most separated element in either mode, which is the point of
the ladder.

**`surface` is not a monotonic scale, and reading it as one makes an element
disappear.** `1` and `3` are raised grounds (white at 78% and 92% in light;
`rgba(20,28,40,.72)` and `rgba(28,38,53,.94)` in dark) while `2` and `4` are
recessed, `4` the deeper. So one step deeper than `2` is `4`, not `3`. Even that
is not a safe way to nest something thin: stacking `2` then `4` moves the red
channel about 15 in light but only about 4.5 on dark's near-black ground, so a
4px bar track survives one mode and vanishes in the other. **A border token is
the right choice for anything thin sitting on a filled surface** --
`--bui-border-2` is navy at 11% in light and pale blue at 14% in dark, defined
as contrast against whatever it sits on, so it darkens on a light ground and
lightens on a dark one.

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
- **A second suite flakes the same way, and it is Postgres-backed too.**
  `CommitHistoryOwnershipResolver.test.ts` failed **18 of 18** in a full run
  that took it 164 seconds, and passed **18 of 18** run alone in a fraction of
  that. Same signature as the `plugin.test.ts` flake below -- fine in
  isolation, fails under full-suite concurrency, and the timing points at
  contention or timeouts rather than logic. **Do not read a full-run failure in
  a database-backed suite as a regression until it has been run alone.** Two
  suites now show it, so the cause is more likely shared than local.
- **Unexplained flake, now worked around:** `plugin.test.ts` used to assert the
  `sync_state` primary key _behaviourally_, by inserting a duplicate and
  expecting a rejection. In the full-repo run that failed roughly one run in
  four with "Received function did not throw", and passed every time it was run
  alone, with diagnostics added, or wrapped in a single transaction -- so the
  connection-pool theory was wrong and the cause is still unknown. The DDL does
  contain `primary key (resource)`. The test now asserts that DDL instead, which
  is deterministic. If the behavioural form is ever reinstated, expect the
  flake back.
- **The unit suite runs on SQLite, so store SQL must be portable.**
  `startFleetTestDatabase` boots `startTestBackend` with no Postgres
  configured, which is why `ProductivityStore`'s `date_trunc` has never been
  exercised by a test. `IS DISTINCT FROM` is the same trap: it is the natural
  way to write "approved by somebody who is not the author" and it does not
  exist in SQLite. `reviewSummary` therefore does the comparison in JavaScript
  from a second query rather than a correlated subquery -- chunked at 200 ids,
  because SQLite caps bound parameters per statement and a busy repository can
  carry more merged pull requests in the window than that cap allows.
- **Never edit a migration that has already run.** Knex records migrations by
  filename, so an edit is silently a no-op against any database that already
  applied it -- the unit tests still pass, because they migrate a fresh
  database every time, and only the live run fails. This cost a debugging cycle
  on `20260824b_ownership.js`, where two columns added after the first run left
  41 repositories failing with `column "is_proposed" does not exist`. Add a new
  migration instead; the only exception is one that has never left this
  machine, which can be dropped from `knex_migrations` and re-applied.
- **`RepositoryFactsCard.test.tsx` fixtures are NOT type-checked.** Its `ok()
helper takes `body: unknown`, so adding a required field to
`ReviewSummaryView`compiled clean while two fixtures still lacked it and the
card rendered "undefined of 53".`yarn tsc` cannot catch this; only reading
  the fixtures can. Update them whenever a view type gains a field.
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
- **There are four bands, and `critical` is now `at-risk`.** The product owner
  specified the thresholds on 2026-09-09, which closed open decision 2:
  Excellent 90-100, Healthy 75-89, Needs Attention 60-74, At Risk below 60.
  `DEFAULT_BANDS` (was `PROVISIONAL_BANDS`, a name that had become a false
  claim) carries them and a test pins the numbers.
  **The rename is a data change, not a relabelling.** `repo_score.band` stores
  the band string, so leaving it `critical` while showing "At risk" would mean
  anyone reading the table saw a word the specification does not use. But score
  history is append-only: 7,915 rows still say `critical`, only the latest row
  per repository is rewritten by the next pass, and those old rows exist for
  ever. So `canonicalBand` in **`fleet-common/src/bands.ts`** is the single
  place that knows `critical` means `at-risk`, and it must be applied before
  any band is **compared or counted** -- the fleet page's band filter is an
  equality test against the value its own segment was built from, so raw
  comparison made "At risk (58)" filter to nothing. Four callers: the overview
  endpoint's counts, `bandCounts`, `filterRepositories` and the search
  collator, which also indexes the canonical value so a facet cannot offer a
  band no filter serves. `isSatisfactoryBand` lives beside it.
  **Nothing may index a band map directly.** `plugins/fleet/src/bands.ts`
  exposes `bandLabel`/`bandText`/`bandFill`/`bandSeverity`, which canonicalise
  on the way in; its maps are keyed by the current names only. Before that the
  legacy name was encoded in two places and would have drifted.
  **`band !== 'healthy'` is now a bug, and it was written twice** -- in
  `shouldHighlightProblems` and in `dormancyCounts.underperforming`. With
  Excellent above Healthy both bannered the _best_ repositories on the estate.
  Ask `isSatisfactoryBand`, which also refuses to assume an unrecognised band
  is good news.
- **Four bands, three colours, and that is the specification.** Its
  classification table marks both Excellent and Healthy with a green circle, so
  they share the positive intent; the label distinguishes them. This is why no
  fourth `--portal-*` token pair was added, and why `bands.test.ts` asserts the
  sharing explicitly rather than dropping its distinctness check -- a band
  picking up a _neighbouring_ intent must still fail.
  The cost is that the segmented band bar had two adjacent identical greens
  with no visible boundary. The fix is an `inset 1px 0 0 var(--bui-border-2)`
  on every segment but the first -- an inset shadow, not a border, which would
  consume width and reflow the flex sizing that carries the counts. Measured
  live: `rgba(20, 40, 66, 0.11)` in light and `rgba(148, 178, 214, 0.14)` in
  dark, so it reads on all three tints in both modes.
- **Re-banding moved 23 repositories with nothing about them having changed.**
  Measured 2026-09-09 across 98: 42 critical to at-risk (the same band,
  renamed), 18 healthy unchanged, 3 needs-attention unchanged, and then the
  real movement -- **12 healthy promoted to excellent**, **7 healthy demoted to
  needs-attention** (the floor rose 70 to 75) and **16 needs-attention dropped
  to at-risk** (that floor rose 40 to 60). The estate reads worse in total, 58
  at risk against 42 critical, while 12 repositories now stand out as the best
  of it. **No score moved** -- only the thresholds did -- so the trend chart
  genuinely contains a step at this change that no repository earned.
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
- **Recency is two metrics, not one, and they must read different
  timestamps.** "Main branch is up to date" and "Active development" have the
  same 30/60/90 day boundaries, and measuring both from one timestamp would
  make the second metric free marks. `mainBranchCurrent` reads
  `activity.lastCommitAt`, which is default-branch-only because
  `CommitIngestionService` ingests only that branch, so it is exactly the field
  the rule asks about. `activeDevelopment` reads the newest head across **every**
  branch, from `BranchSummary.lastCommitAt` -- returned at no cost, since that
  query already reads each branch's timestamp to count the stale ones.
  **The split pays for itself.** Measured on the pass at 08:01 on 2026-09-09:
  54 repositories are current on both, 37 are quiet everywhere, and **7 have a
  stale main branch with live work on a branch** -- `plugin_count` is 238 days
  stale on main and 34 days on a branch. Those 7 are the ones where work is
  happening and nothing is shipping, and a single timestamp would have scored
  them the same as the 37 that are simply dead.
  **The ladders have the same days and different shapes**: 20/7/3/0 for main,
  10/7/3/0 for development. The second falls away far more gently, so a
  slowdown costs much less than main going quiet. `recencyLadder` in
  `scorers/recency.ts` is shared, and reports each rung as a share of the
  **top** rung, so the ladder describes itself and a reweighting cannot change
  the proportions.
  **Beyond the last rung is zero, not the last rung's points.** The first
  version fell through to `bands[bands.length - 1]`, which paid every
  repository whose main had been quiet for years the same 3 of 20 as one quiet
  for 90 days -- 44 repositories scoring the bottom band instead of nothing.
  Only a test at 91 days found it; the estate figures looked plausible.
  **A future timestamp is treated as current.** Committer dates come from
  whoever made the commit, so a skewed clock is possible and is not the
  repository's fault; a negative age falling through every rung would report an
  actively developed repository as abandoned.
  **The "on a branch, not the default one" note is only said when main is
  itself behind.** Found by reading the stored details rather than by reasoning:
  `demand-ai-website` has a commit on main _today_ and a branch head seconds
  newer, and the note therefore described a perfectly current repository as
  having work stuck on a branch. It now reuses the ladder to ask whether main
  is at full marks, so the two can never disagree about where the boundary is.
- **Stale branches are COUNTED, not scored as a ratio, and that changed the
  answer for 34 repositories.** `branchHygiene` scored `active / total`, so one
  stale branch out of twenty scored 0.95 while one out of two scored 0.5 -- the
  same single branch needing the same single deletion. Worse, the ratio made
  the metric a restatement of dormancy: measured across the two passes either
  side of the change, **repositories scoring zero fell from 38 to 4** and
  estate-wide points rose **482.9 to 806.7**. Only 4 repositories have more
  than five branches to delete; the other 34 were being marked down for having
  no _recent_ branch activity, which the recency metrics already say.
  **Only 2 repositories changed band, in opposite directions.** `dxp-mono` fell
  61 to 57 because 9 stale branches is beyond the top band where the ratio had
  given it partial credit for the branches that _were_ active -- the metric
  finally doing its job. Average total rose 5.5 with almost no band churn: the
  gains were broad and sub-threshold.
- **The exemption list has to reach the STORE, not the scorer.** The scorer only
  ever sees counts, and the repository card names the stalest branches from a
  separate query, so `BranchStore.summary` and `BranchStore.stalest` both take
  the list and `plugin.ts` threads one value into the scoring service and the
  router. **Both options are optional, so omitting one typechecks perfectly and
  simply scores the exempt branches anyway** -- which is what happened first,
  to the scoring service. There is no compile-time guard; check both call sites.
  `DEFAULT_STALE_BRANCH_EXEMPTIONS` is `stage`, `staging`, `dev`, `dev-stage`
  -- measured, not guessed, and worth roughly 750 of the estate's 2,699
  stranded commits. **`master` is deliberately absent** though 2 repositories
  carry a stale one: a `master` left by a rename to `main` is exactly what this
  rule exists to catch. Nothing speculative is listed either -- a default that
  forgives a branch nobody has is a silent hole in the metric. This settles
  open decision 9 for scoring; branch _divergence_ still counts them.
  Verified live: 4 repositories reached full marks purely because their only
  stale branch was a deliberate one.
  **Matched case-insensitively through `lower(name)`**, which is the one
  spelling that works on Postgres and on the SQLite the unit suite runs. This
  estate is already demonstrably inconsistent about case.
- **Zero stale branches earns full marks, including for a repository that has
  only its default branch. This reverses the branch-hygiene reasoning**, which
  called that unmeasurable on the grounds that full marks would flatter
  something empty. That was really a guard against dividing by zero in a ratio;
  with a count there is no division and "nothing needs deleting" is a true and
  complete measurement. An empty repository is answered by the recency and
  README metrics, which is where it should be answered.
  The default branch is never counted however stale it is -- its staleness is
  `mainBranchCurrent`'s job, and suggesting somebody delete the branch the
  repository is built on would discredit the whole scorecard.
- **A scorer's title labels the measurement; only the specification's heading
  asserts the desired state.** Titling this one "No stale branches", as the rule
  is named, made the scorecard row read **"No stale branches -- 5 branches with
  no commit in 90 days"**, a flat contradiction. It is "Stale branches" now, and
  the zero case reads "None need deleting" rather than repeating the title. The
  other titles survive the same reading because they do not assert a negative:
  "README available -- No README at the repository root" is fine. Found in the
  browser; no test and no type would have shown it.
- **`deriveProblems` keys dormancy on a metric id, so replacing that metric
  silently breaks it.** `ACTIVITY_METRIC` was `active-commits`; with the
  commit-volume metric retired, dormancy would have stopped classifying all 37
  dormant repositories and nothing would have failed. It is
  `active-development` now -- deliberately the repository-wide metric rather
  than the main-branch one, because **main going quiet while a branch is busy
  is a shipping problem the team should be told about, not dormancy**. The old
  id is kept as `LEGACY_ACTIVITY_METRIC` and read as a fallback, because stored
  breakdowns outlive the scorer that wrote them and every repository would
  otherwise lose its dormancy statement for exactly one cycle.
  `ACTIVITY_DERIVED` grew to four ids for the same reason it existed: a dormant
  repository scores zero on main recency, on development, on contributors and
  badly on branch hygiene, and that is one fact wearing four hats.
  **Partial credit is what separates the two populations now.** 37 repositories
  score zero on development and get the dormancy statement; **17 more lose
  points without reaching zero** and get "No recent development" as a real
  problem. The old volume metric could not tell those apart.
- **Do not spread a store shape into an API response.** `router.ts` built
  `BranchSummaryView` with `...branchSummary`, so adding `lastCommitAt` to
  `BranchSummary` for the recency scorer leaked a raw `Date` into the response
  under a view type that does not declare it, bypassing `iso()`. The fields are
  named explicitly now. `yarn tsc` does not catch this -- the view is wider
  than declared, not narrower.
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
- **The security-scan metric was dropped on 2026-08-26**, at the product
  owner's direction. **Section 7's security-scan requirement did not disappear
  with the metric**; the portal simply no longer tracks it, and nothing now
  reports that gap. The weight arithmetic that used to be recorded here
  described an eight-metric scorecard and is superseded by the rule rewrite --
  see "the scorecard is the requirement's seven rules" below for the weights
  that are actually registered.
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
- **The scorecard is the requirement's seven rules and nothing else, at its own
  weights, in its own order.** 20 / 15 / 20 / 15 / 10 / 10 / 10 = 100, pinned by
  a test. The card renders the breakdown in registration order, so the document
  can be held beside the page and checked line by line -- which is worth more
  than it sounds, because it is how the "Main branch" collision below was found.
  **Three working, tested metrics were unregistered on 2026-09-09** at the
  product owner's direction -- the instruction was to display only what the
  requirement demands: `activeContributors`, `pipelinePassing` and
  `ownerAssigned`. **Unregistered, not deleted**, on the same principle that
  kept `unmeasuredScorer`: they work, they are tested, and pipeline passing is
  the likeliest to come back since it was the estate's most widespread problem
  at 38 repositories. Each file now opens with a **NOT REGISTERED** note saying
  how to reinstate it. `ScorerContext.pipelines`, `.ownership` and
  `activity.authors` are still populated, so reinstating one is a line in
  `plugin.ts` plus a weight rebalance -- the fetches are deliberately kept for
  exactly that reason, and the dead queries are the price.
  **The ownership register is untouched and that is the important part:**
  `spec.owner`, the catalog's Owner column and filter, the `confirmed-owner`
  tag and the About card all still work. Only the ten points stopped.
  **Measured on the pass at 09:42: the estate reads worse.** Excellent 4 to 2,
  Healthy 23 to 15, Needs Attention 19 to 22, At Risk 52 to 59, average 57.6 to
  53.7. The three dropped metrics were collectively yielding about half their
  weight, and `ownerAssigned` alone paid **10 of 10 to 89 of 98 repositories** --
  the single most reliably earned metric on the card, and the estate's main
  source of easy points. What remains is the harsh banded set.
- **Pull request size is measured now, and the probe settled three things
  before a line was written.** Probed read-only 2026-09-09 across 48 pull
  requests:
  - **The pull request list carries no diffstat under any spelling.**
    `values.diffstat`, `values.lines_added`, `values.lines_removed`,
    `values.size` and `values.summary.size` all come back absent or `{}`. So
    unlike `merge_commit.hash` and `participants`, this one genuinely **cannot**
    ride an existing call -- the "ask and the field appears" lesson has a limit,
    and this is it.
  - **One request covers a pull request.** `pagelen=500` is accepted and none of
    the 48 paginated, the largest being 158 files. The loop over `next` is there
    for correctness, not for this estate.
  - **The `fields` selector IS honoured**, and a first probe appeared to prove
    otherwise: `fields=size,next,values.lines_added,...` returned
    `{"values":[],"size":0}`. That was `oxp-backend#112`, a merged pull request
    with a genuinely **empty** diffstat -- which is also why the size columns are
    nullable, so "never fetched" stays distinct from "changed nothing".
- **Excluding generated files is worth 0.7% of the estate, not the 21-25% a
  three-pull-request sample said.** This is the Deployments-API mistake in
  miniature and worth reading as one: a lockfile really was 6,813 of
  `dai-delivery#1`'s 31,856 lines and 2,077 of `daarwyn-bo-ui#1`'s 8,257, and
  generalising those two into a claim about the estate was wrong. **Measured
  across all 391 merged pull requests: 15,681 excluded lines out of 2.2
  million.** The exclusion is still right -- it is free, the requirement asks
  for it, and it stops a dependency bump costing points -- but it fixes almost
  nothing.
  `DEFAULT_GENERATED_PATHS` in `analysis/diffstat.ts` matches lockfiles by exact
  name and vendored directories by **path segment**, so `src/dist-helper.ts` is
  source where `dist/index.js` is not. Deliberately conservative:
  over-excluding flatters a repository, which is the worse failure for a metric
  meant to find risk.
- **What actually inflates this metric is branch promotion, and no exclusion
  rule can touch it.** The estate's largest pull requests are titled "Prod
  migration", "Promote stage to main" and "Staging sync main":
  `portal-apis#73` moved **601,858 lines across 3,304 files, 3,301 of them
  newly added**, and `ingest-jobs#18` 577,323 across 3,809. Those are release
  mechanics -- a long-lived `stage` branch landing on `main` -- not changes
  anybody reviewed or could have made smaller. The same `stage`/`staging`
  branches the stale-branch metric exempts are what produce them.
  **`files_added` is the field that identifies them**, at 99.9% of files added,
  which is why it is stored even though nothing scores it.
  Measured over 90 days across the 44 repositories with merged pull requests:
  **13 average under 400 changed lines, 6 between 400 and 1,000, and 25 over
  1,000** -- so 25 repositories score 1 of 10, most of them for release
  mechanics. So the specification's **mean** is a poor description of this
  estate. It is implemented anyway, because it is what the requirement bands,
  but:
  - per-pull-request figures are **stored**, so median or any other statistic
    is a query rather than a 390-request refetch;
  - `files_added` is stored too, from the same response, because the added-file
    share is the only field that separates an import from a change -- CLAUDE.md
    already records what needing a second backfill costs;
  - the detail line reports the median beside the mean when they disagree, and
    names the imports, so the number is not read as a verdict on the team.
  - The bottom band pays **1, not 0** -- the only band on the scorecard that
    does. A team merging 5,000-line pull requests is at least merging pull
    requests.
- **A long sweep must write as it goes, and the first live run proved it the
  expensive way.** The original `PullRequestSizeService` collected all 390
  results and wrote once at the close. The sweep ran for **over 16 minutes**,
  met its 20-minute task timeout, and was killed having written **nothing** --
  `sync_state` showed an attempt with no success and **no error**, because an
  external abort never reaches the service's own catch. Every request it had
  paid for was discarded, and the next sweep would have paid again. It writes in
  batches of 25 now and the timeout is 40 minutes. **Symptom to recognise: an
  attempt timestamp with neither a success nor an error is a killed task, not a
  failed one.** The second sweep hit the same 20-minute limit -- the running
  backend still held the old timeout -- but kept its 225 measured rows, which
  is the fix working; a third finished the remaining 166.
- **The whole estate is measured: 391 merged pull requests, 2.2 million changed
  lines, in about 400 requests across three sweeps.** `available_weight` now
  reaches **100** where it had topped out at 90, so no repository forfeits
  points for a metric the portal could not measure. Points on the metric split
  **13 repositories at 10, 6 at 3, 25 at 1**, with 54 unmeasurable for having
  no merged pull requests at all. Estate bands moved 2/15/22/59 to
  **1/14/29/54** and the average barely at 53.7 to 52.4 -- at-risk fell by five
  because a measurable metric pays something where a forfeited one paid
  nothing.
- **Open decision 11, measured 2026-09-10: the mean scores release mechanics,
  not review burden.** Three candidates banded the specification's way, across
  the 44 repositories with merged pull requests in the window:

  | statistic              | 10 pts | 3 pts | 1 pt | unmeasurable | mean points |
  | ---------------------- | -----: | ----: | ---: | -----------: | ----------: |
  | mean, as specified     |     13 |     6 |   25 |            0 |        3.93 |
  | median                 |     24 |     7 |   13 |            0 |        6.23 |
  | mean, imports excluded |     20 |     6 |   11 |            7 |        6.19 |

  **The repositories the mean punishes are the disciplined ones.**
  `oxp-backend` merged **66** pull requests typically **240** lines long -- the
  busiest repository on the estate and among the best-behaved -- and scores 1
  of 10 because one promotion moved 35,028 lines.
  `daarwyn-data-sync-jobs` is 12 pull requests with a median of **3** and a
  mean of 2,730. `ingest-jobs` is 3 with a median of **76** and a mean of
  **192,474**.
  **Excluding imports was measured and rejected**: it leaves 7 repositories
  unmeasurable, and it does not rescue `portal-ui`, `crm` or `daarwyn-ui`,
  whose large pull requests are **not** mostly-added files -- so the
  `files_added` heuristic does not catch them. The median does.
  Built as `fleet.scoring.metrics.pullRequestSize.statistic`, defaulting to
  `mean` so the shipped behaviour still follows the document. Switching is a
  product decision, reversible without a deploy -- the same reasoning as
  `codeReviewCompleted.countSelfApprovals`.
  Whichever is scored, the detail line names the **other** statistic when they
  disagree by more than a factor of two, so neither number is read alone.

- **The detail line justifies itself on the first repository that renders it.**
  `daarwyn-data-sync-jobs` reads "2730 changed lines on average across 12
  merged PRs in 90 days, **typically 4**". One promotion pull request sets the
  mean for twelve that are typically four lines long. That clause is the whole
  argument for storing the median, and it appears only when the two disagree by
  more than a factor of two, so it stays quiet where the mean is honest.
- **A short denominator now has two unrelated causes, and one sentence about
  both was wrong.** Pull request size is a gap in the **portal**; code review
  going unmeasured means **this repository** merged nothing. Reporting the
  first as the second sends a team hunting data that exists and that nothing
  has asked Bitbucket for. A scorer returning `null` carries no reason, so
  `isPortalGap` in `fleet-common/src/problems.ts` holds the ids that are ours
  -- delete the entry when the diffstat ingestion lands. The card partitions
  `problems.unmeasured` by it, which finally gave that field something to do:
  it had been computed and never rendered. Live: `ux-designs` reads "Scored
  over 55 of 100 weight. Pull request size cannot be measured by the portal
  yet. Main branch health, Code review completed have nothing to measure in
  this repository."
  **The same text used to end "Band thresholds are placeholders pending
  sign-off", which had been false since decision 2 closed.** A test now asserts
  the words "placeholders" and "pending sign-off" are absent.
- **Two adjacent rows whose names differed by one word measured different
  things.** Trimming the scorecard to seven rules put `pullRequestDiscipline`,
  then titled "Main branch health", directly beneath "Main branch up to date".
  It is **"Changes through pull requests"** now, which says what it measures and
  matches the problem chip's wording. The id is unchanged, so stored breakdowns
  and the fleet filter still match. Visible only on the rendered card -- no test
  and no type would have shown it, and neither would reading the registration
  list, because the collision is created by adjacency.
- **The scorecard totalled exactly 100 at every step of the rule rewrite, and
  that cost interim weights.** A scoring pass fires every 30 minutes and its
  rows are append-only, so an intermediate state where the weights total 110 or
  130 would write permanent history at a scale that is nobody's intended
  answer. So each step preserves the sum: the two recency metrics were
  registered at **13 and 7**, splitting the 20 the retired commit-volume metric
  held in the 2:1 ratio the specification gives them, and
  `pullRequestDiscipline` and `codeReviewCompleted` keep 10 each rather than
  taking their specified 20 and 15. The specification's absolute figures arrive
  in **one** change together with the removal of the dropped metrics. The band
  _proportions_ are already the specification's everywhere, because every band
  table is expressed as a fraction of the configured weight.
  The consequence to remember: **remediation text must never quote absolute
  points.** Two scorers did, and were wrong on the page the moment the interim
  weights landed. Quote the day threshold or the share instead.
- **Registering the tenth metric took nominal weight to 110.** Scores still
  normalise over `availableWeight`, and the card shows the denominator, but every
  score shifted again. Rebalancing to keep 100 is a config change and a product
  decision, not a code one.
- **The catalog tag and the fleet filter are different surfaces.**
  `direct-commits-to-main` on the entity filters the **catalog** page;
  the **fleet dashboard** reads `/api/fleet/overview` and needed
  `FleetRepositorySummary.directCommits` plus a chip in `FleetFiltersBar`. Adding
  a tag does nothing for the fleet page -- that mistake was made here first.
- **The ownership metric is NOT REGISTERED any more** -- unregistered
  2026-09-09 with the rule rewrite, because the requirement's seven rules do not
  include it. Everything below still describes how it behaves and is kept
  because reinstating it is one line in `plugin.ts`: `ScoringService` still
  resolves ownership and populates `ScorerContext.ownership`. **The register
  itself is untouched** -- `spec.owner`, the catalog's Owner column and filter,
  the `confirmed-owner` tag and the About card all work exactly as before.
  **A derived owner earns zero, not partial credit** -- the portal can name a
  likely owner for nearly every repository, and if a guess scored, the estate
  would report as owned while nobody had agreed to own anything.
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
- **Approval is not review, in this estate, and the reason is self-approval.**
  Measured 2026-08-25 from 243 approved merged PRs: median time from opening to
  first approval is **12 seconds**, and **169 of 243 (70%) are approved within
  five minutes**. p90 is 3.8 hours and the tail reaches 10 days, so real review
  does happen on a minority.
  **Measured 2026-09-09, which explains it: of 365 pull requests merged in 90
  days, 265 carry an approval and only 85 carry one from anybody other than the
  author.** 180 self-approvals. A 12-second approval is not fast review, it is
  the author clicking approve on their own work. So `ReviewSummary.peerApproved`
  exists beside `approved`, and `codeReviewCompletedScorer` scores the former by
  default -- the rule it implements says "PRs should receive **peer** review",
  and the specification's baseline is "Author cannot approve own PR".
  `fleet.scoring.metrics.codeReviewCompleted.countSelfApprovals` reverses it
  without a deploy, because of how much it moves: measured across the two
  scoring passes either side of the change, estate-wide points on that metric
  fell **321.8 to 50** and repositories scoring zero went from **7 to 39 of the
  44 that can be measured at all**. Only 5 repositories on this estate earn
  anything for code review once self-approvals stop counting.
  **A peer approval requires both account ids known and different.** An
  approval the portal cannot attribute is not evidence a second person looked.
  Costs nothing today -- no row in either column is null -- and a test pins it
  so a future ingestion gap cannot manufacture reviews.
  **The card had to change with the scorer.** It reported "265 of 365 reviewed";
  a scorecard saying 0 of 10 beside it would read as a portal defect. It shows
  peer approvals with the self-approved count in the hint, so it agrees with
  either setting of the config rather than tracking one of them.
- **Banded scoring is expressed as a fraction of the configured weight, never
  as absolute points.** The specification's tables give points -- 20 / 7 / 3 / 0
  for pull-request discipline, 15 / 7 / 0 for review -- but `Scorer` returns a
  0..1 fraction that the engine multiplies by a **configurable** weight. So the
  band tables are written as `7 / 20` and `7 / 15` rather than as decimals:
  each entry then states the points it is worth at the nominal weight, and the
  proportions survive a reweighting instead of silently becoming a different
  share of a different total.
  **Full marks for "100%" is an integer comparison, not `share >= 1`.** The rule
  is that nothing bypassed a pull request; comparing counts says that without
  depending on how a division rounds, and a repository 1 commit short of
  perfect must land in the band below rather than float up into it.
- **The middle bands of the pull-request rule are unreachable here, and it is
  arithmetic.** 95-99% cannot be expressed with fewer than 20 mainline commits
  in the window. Measured 2026-09-09 over 30 days: **32 repositories at 100%, 9
  below 80%, and not one in either middle band** -- so the metric pays 20 or 0
  on this estate. Implemented anyway rather than collapsed to pass/fail: it
  starts to discriminate as repositories get busier.
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
- **The dev backend's watcher does not always pick up an edit, and the symptom
  is a pass that runs and changes nothing.** Changing
  `BitbucketRepositoryEntityProvider` and triggering the provider task produced
  "Registered 98 repositories" in the log and entities built by the **old**
  code. Nothing in the log says so. It was only detectable by inspecting what
  the pass emitted -- the previous version prefixed a System's description with
  the project name and the new one does not, so reading
  `final_entities` settled it in one query. A backend restart fixed it.
  So: after editing backend code, do not conclude anything from a task running.
  Check a value that differs between the two versions.
- **Config read at plugin `init()` is NOT hot-reloadable, and a scoring pass
  will happily run with the old value.** Backstage reloads `app-config.yaml`
  into the `Config` object, but `plugin.ts` builds the `ScoringEngine` -- and
  every scorer's options with it -- once during `init()`. Editing
  `fleet.scoring.metrics.pullRequestSize.statistic` and triggering the pass
  therefore rescored the whole estate **with the old statistic** and reported
  success. Only a backend **restart** re-runs `init()`.
  Contrast `catalog.locations`, which the scaffolder removal did hot-reload:
  that config is read continuously by the catalog, not captured at startup.
  The test is whether a value is baked into an object at init.
  **Touching a source file to force the watcher does not work** -- changing
  only `LastWriteTime` left the backend running the same build through eight
  polls. The watcher wants a content change, or a real restart.
  **And the obvious discriminator was useless here**, which cost a round:
  "does the detail say `typically`" looked like it would separate the two,
  but the mean path _already_ printed a `typically N` contrast clause, and the
  new code scoring the mean emits a byte-identical string to the old code. The
  discriminator has to be a value that differs **between the two
  configurations**, not merely between two code versions:
  `'% changed lines typically across%'` -- the median leading the sentence --
  is the one that works.
- **A task's schedule survives a restart, so `initialDelayDuration` does not
  re-fire.** `next_run_start_at` is persisted in
  `backstage_backend_tasks__tasks`, per plugin database -- so restarting to pick
  up a code change does **not** pull the next pass forward, and a change that
  depends on ingestion can sit invisible for up to the full cadence (30 minutes
  for the repository passes). Verified 2026-09-08: after three restarts the next
  run was still 21 minutes out. To make a pass land now,
  `update backstage_backend_tasks__tasks set next_run_start_at = now() where
id = '<task>'` -- which is the scheduler's own next action, just sooner, and
  it reschedules normally afterwards. Do that rather than polling; **do not**
  read "the code is deployed" as "the data has changed".
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
- **Bitbucket exposes no repository creator, and no branch ahead/behind.**
  Verified against the live API 2026-09-01: the repository object carries
  `owner`, but for a workspace repository that is the _workspace_
  (`{"type":"team","display_name":"DemandAI"}`) -- there is no `creator`,
  `created_by` or `author` field, and a branch object has only `name`,
  `target`, `links`, `type` and merge strategies. Both facts have to be derived,
  which is what `CommitStore.firstCommit` and `BranchDivergenceService` exist
  for. Do not go looking for the field again.
- **51% of merged pull requests here are squashed, and that breaks two
  plausible metrics.** 178 of 346 leave no merge commit. A squash rewrites the
  branch's commits into one, so the originals stay unreachable from the default
  branch **for ever** -- they are never ingested, and the squashed commit looks
  like a single-parent mainline commit. So: counting `merged-in` against
  `direct` reports squash-merging teams as pushing straight to main, and
  `commits?exclude=main` reports shipped branches as fully diverged (2 of 8
  sampled on `oxp-frontend`). `BranchPolicyService` avoids the first by matching
  the pull request's **merge hash** -- 91 of 219 mainline commits attributed to
  a pull request have a single parent, and a parent-count rule would have missed
  every one. `BranchDivergenceService` avoids the second by skipping any branch
  that is the source of a merged pull request, using the already-stored
  `pull_request.source_branch` (77 of 262 branches).
- **`BranchStore.replaceForRepository` must carry divergence across the
  replace.** Branch ingestion replaces every row wholesale every 30 minutes;
  divergence is measured every 6 hours. Without carrying it, nothing would ever
  be readable. It is **dropped when the branch head moved**, because a stale
  figure shown as current is worse than showing nothing. Two tests pin both
  halves.
- **`min-width: 0` is load-bearing on any scroll container inside a `Flex`.**
  A flex child defaults to `min-width: auto`, so an `overflow-x: auto` wrapper
  grows to its content's minimum instead of scrolling -- the page then scrolls
  sideways and pinning the sidebar (224px) cuts the table. Bit the fleet and
  productivity tables (`minWidth: 62rem` / `54rem`) and, in a different guise,
  the About card's value column. The catalog page has the same problem in its
  MUI `Grid item lg={10}`, deliberately **not** fixed: without confirming
  material-table's container scrolls, letting the item shrink would clip the
  Tags column rather than scroll it, and unreachable is worse than off-screen.
- **`sidebarOptions={{ drawerWidthOpen }}` is half-wired -- do not use it.**
  It widens the drawer, but `Sidebar` provides `SidebarConfigContext` _inside
  itself_ while `SidebarPage` sits above it and reads the same context to set
  the content's `padding-left`. The padding therefore keeps the default 224 and
  a widened drawer **overlaps the page whenever the sidebar is pinned**. The
  context is not exported, so the padding cannot be made to follow. Truncated
  labels are fixed by reclaiming space inside the row instead: `secondaryAction`
  reserves 56px on every item for submenu arrows and badges that our nav items
  do not have, which left the 110px label only ~112px and no free space for its
  `flex-grow` to use. The theme sizes both to content.
- **`page:catalog` IS replaced, and this corrects an earlier note here saying
  it could not be.** That note said the catalog index route ref "is not exported
  by anything", so replacing the page would break every "back to catalog" link.
  The premise was wrong: there is no exported `catalogIndexRouteRef`, but the
  plugin declares `routes: { catalogIndex: rootRouteRef }`, so the ref is
  reachable as `catalogPlugin.routes.catalogIndex` -- and
  `packages/app/src/modules/catalog` reuses that exact ref, so
  `EntityLayout`, `EntityOrphanWarning` and `plugin-org`'s ownership grid all
  resolve what they always did.
  **Why it was worth doing:** `CatalogIndexPage` takes a `tableOptions` prop and
  that is the only route to `paginationType: 'stepped'`, which is what gives
  numbered page buttons and the "1-20 of 96" count instead of two bare arrows.
  The stock extension exposes only `pagination` and `exportSettings` in config,
  neither of which reaches it, and there is no swappable component for the table
  or its pagination anywhere in `core-components` or `plugin-catalog`.
  **Two things it costs.** Backstage's own improvements to `page:catalog` stop
  arriving -- check that file on a `plugin-catalog` upgrade. And the module must
  re-declare the `filters` extension input, or the filter column silently
  vanishes: `catalog-filter:catalog/kind` and friends attach to it.
  Deleting the module restores the stock page exactly.
  It also unlocks `columns`, `emptyContent` and `actions`, which the positional
  column-hiding CSS in the theme is a workaround for. **That has now been
  done**: the module passes a `columns` array naming Name, Project, Owner and
  Tags, plus `actions={[]}` to drop the Actions column, and the positional
  `thead th:nth-child(n + 4):not(:last-child):not(:nth-last-child(2))` rule is
  gone from the theme along with the standing warning that an upstream reorder
  would silently hide the wrong columns.
  **Removing Actions moved a second rule onto the wrong column.** The theme
  shrank the last two columns to `width: 1%` because Tags sat beside Actions;
  with Actions gone, `nth-last-child(2)` was Owner, which holds the longest
  values on the page. One rule now, on the last child only.
- **Passing no `pagination` to `CatalogIndexPage` silently reorders the table.**
  Found by diffing row order after the override above. The stock extension
  passes `config.pagination`, which defaults to `true` and means cursor mode --
  server-ordered. Omitting it drops the list to `none`, and `CatalogTable`'s
  fall-through then sorts client-side with lodash `sortBy`, a plain
  case-sensitive comparison: page one became `Archieve`, `DAARWYN_PORTAL`,
  `DataAgentUI` -- every capitalised name first. The module passes
  `{ mode: 'offset', limit: 20 }`, which keeps ordering on the server and,
  unlike cursor mode, knows the total count -- which is what the numbered
  buttons and the row count are both computed from.
  **material-table's stepped pagination shows a fixed +/-1 window** around the
  current page (`pageStart = page - 1`, `pageEnd = page + 1`, hardcoded), so on
  five pages you see two or three numbers, not all five. First/Previous/Next/
  Last are always there. Not configurable without replacing the pagination
  component, which `CatalogIndexPage` does not expose.
- **The catalog page's outer shell is BUI, not MUI.** `NfsDefaultCatalogPage`
  renders BUI's `Header` and `Container`. Everything inside (table, toolbar,
  filter column, empty state) is MUI and is reachable through the theme's
  component overrides. Our own cards are BUI too, which is why
  `BackstageInfoCard` overrides do not touch `RepositoryFactsCard`.
  **This corrects an earlier note here saying the page's outer gutters are not
  themeable.** That was true only while a MUI theme was the sole lever. The
  gutters, the header and the container are all `--bui-*` driven and the portal
  now owns that layer -- `globalCss` zeroes `bui-Container`'s 20px horizontal
  padding, which is what brings the catalog to the same 24px gutter as the
  fleet and productivity pages.
- **A section inside a card is `sectionPanel`, and nothing inside it may also be
  `recessed`.** The Repository activity card holds eight sections, and dividing
  them with rules only says "these two things are different" -- it does not say
  where a section begins and ends, which is what a reader scanning for one fact
  needs. They are filled, hairlined sub-cards now: **recessed, never raised**,
  because a shadow inside the card's own shadow reads as a seam rather than as
  depth. The trap is that `recessed` is `--bui-bg-neutral-2` and the metric
  bar's track was **the same token**, so filling the Scorecard erased all eight
  tracks and left the bars floating with nothing to measure against. Tracks and
  other inner grounds take `--bui-border-2` -- see the surface-scale note above
  for why not `neutral-3` or `-4`.
  The panel edge also replaced a spacing cascade. Sections divided by a rule
  need the gap **above** the rule to exceed the padding below it, or the rule
  floats midway between two sections and reads as belonging to neither; a drawn
  boundary needs no such asymmetry, so the card body's gap came down from 24px
  to 16px and the card got shorter for free.
- **A section heading and a field label must not share a variant.** These
  headings were `body-x-small` + secondary + bold -- the identical variant and
  colour that `Stat` gives its own labels, distinguished only by weight and
  capitals. At 11px muted that is not a hierarchy step, so "ACTIVITY -- LAST 90
  DAYS" and "Commits (90d)" beneath it read as two items in one flat list rather
  than a heading and its content. Headings are `body-small` in the primary
  colour now, and `sectionHeading` exists beside `sectionLabel` rather than
  reusing it because 0.06em tracking is tuned for 11px and reads gappy at 14px.
- **`spec.lifecycle` is REQUIRED by the Component schema, so "remove
  lifecycle" can only ever mean the UI.** `Component.v1alpha1.schema.json` has
  `required: ["type", "lifecycle", "owner"]` -- an entity without it fails
  validation and is never ingested, so deleting it from
  `BitbucketRepositoryEntityProvider` would empty the catalog of all 98
  components. It is removed from the About card, the "Repositories" table, the
  catalog column and the catalog filter, and it stays in `spec`.
  **The entity header needs two changes together, and each alone makes things
  worse.** `EntityHeaderBui` pushes the item only `if (lifecycle)` and is
  neither an extension nor a swappable component -- `EntityLayoutBui` imports it
  directly -- so there is no React route to it. Blanking
  `entityLabels.lifecycleLabel` alone leaves the VALUE ("experimental") in the
  row with no label. Hiding by position alone is unsafe: lifecycle is first when
  present, but a System has none, so a `:first-child` rule hides its Owner.
  Do both. Blank the label, then hide any `bui-HeaderMetaItem` whose label
  element is `:empty` -- after the blanking that is exactly the lifecycle one,
  since Owner and Project both carry text. Matching emptiness rather than
  position is what makes it correct on every kind, and it is the same
  `:has()` + `:empty` technique the catalog header collapse already uses.
  Verified: a Component shows Owner and Project with the lifecycle item hidden;
  a Project shows Owner, with nothing hidden.
  **An earlier version of this note said the header was the one place lifecycle
  could not be removed. That was wrong** -- it was a conclusion drawn from the
  React side alone, without checking what the DOM offered.
- **"System" reads as "Project" through three separate surfaces, and one of
  them had to be hidden instead.** `entityTableColumnTitle.system` on
  `catalogReactTranslationRef` renames the catalog column;
  `entityLabels.systemLabel` on `catalogTranslationRef` renames the entity
  header's metadata row; `AboutCard` owns its own label. **The kind tag above an
  entity's title is not translatable** -- `EntityHeaderBui` renders
  `entity.kind` raw -- so `bui-HeaderTags` is hidden in `globalCss`, which is
  defensible on every kind because the About card states the kind, the
  breadcrumb states the section and the title states the entity.
  The `kind` itself stays `System` in the model, in refs and in URLs; renaming
  it would invalidate every stored `spec.system` and every link. `AboutCard`
  maps it for display only.
- **A row is hidden when a field does not APPLY, never merely because it is
  empty.** Reclaiming height on the About card by dropping empty rows reversed
  a decision the card's own test records -- "says so plainly when a field is
  absent rather than leaving a gap" -- and the full suite caught it. An em-dash
  says the portal looked and found nothing; a missing row says nothing at all,
  and the reader cannot tell absent data from an inapplicable field. What was
  actually wrong is narrower: `Project` and `Type` are Component `spec` fields,
  so on a Project's own page they are meaningless rather than absent, and
  "PROJECT --" there invited a hunt for data that cannot exist. Gate on the
  kind, keep the em-dash everywhere it means something.
- **`BitbucketRepositoryEntityProvider` reads the API, not the store**, and
  assuming otherwise sends you to the wrong database. It calls
  `client.listRepositories(this.workspace)` directly, so anything it emits comes
  from the live listing and needs no fleet column at all -- `repository.project_name`
  was added for other consumers and is **not** on the path that fills a System's
  description. Two separate scheduled tasks matter here and they live in
  different plugin databases: `bitbucket-repositories:demandai` (the provider,
  in `backstage_plugin_catalog`) and `repositories:demandai` (fleet ingestion,
  in `backstage_plugin_fleet`).
- **The full project name is the System's `title`, and that is the single lever
  for all of it.** Everything that renders a System title picks it up at once:
  the catalog's PROJECT column, the About card, the relations graph and the
  project's own page heading. **This supersedes an earlier note here saying the
  key stays the label and the name belongs in the description** -- that was the
  first plan, and the product owner changed it. `describeProject` is gone with
  it; the description is plain workspace context, because with the name in the
  title, leading the description with it too made a page read
  "DAI Delivery Systems / DAI Delivery Systems. Bitbucket project ...".
  **It fits, and that was measured before committing to it.** In the catalog
  column, less 40px of cell padding and a 20px icon, 138px was usable against
  the longest name's 130px -- and once the column reflowed it had 267px, so
  there is real slack. Verified at 1600px and 1280px: no truncated cell.
  The entity **name** is untouched (`dds`), so refs, URLs and the Project
  filter's facet values do not move. Falling back to the key covers the three
  projects whose name is their key or nearly (DAARWYN, MDLH, DAIWEB/DAI-WEB).
- **The entity header can never show a System's title, and the asymmetry is in
  Backstage's own code.** `HierarchyLinks` renders `ref.name` -- the lowercased
  key -- and never loads the System, so `metadata.title` is unreachable. Two
  fields along, the **Owner** line does resolve one
  (`owner?.metadata.title ?? owner?.metadata.name ?? ref.name`), because it
  fetches the owner entity. So the header could only ever disagree with the
  About card beside it.
  An earlier version of this note upper-cased that link to "DDS", which fixed
  the casing and left one field spelled two ways. **The line is now hidden**
  instead -- `bui-HeaderMetaItem:has(dd ul)`, matched by markup rather than
  position, since a hierarchy value is a list where an Owner's anchor is a
  direct child of `dd`. The alternative was replacing the entity page, which
  `EntityLayoutBui` forces by importing the header directly, and that trade was
  declined for one label.
- **Table sorting is one comparator in `plugins/fleet/src/sorting.ts`, and the
  absent case is the whole of it.** Both hand-rolled tables sort client-side --
  each endpoint sends every row in one response, so a server sort would add a
  query parameter and a round trip per click to reorder data already in the
  browser. Each page supplies only its keys, how to read a cell, and a
  tiebreaker; the generic core was extracted rather than written twice, and the
  refactor is provably behaviour-preserving because the 19 productivity tests
  passed unchanged.
  **Absent values sort last whichever way the column points**, and the check
  sits _outside_ the direction flip -- folding it in sends blanks to whichever
  end the arrow happens to point at. Every sortable column has them: a
  repository never scored, one with no commit (48 of them), one nobody owns; an
  engineer with no merged pull requests, or who reviews and has never committed.
  Treating those as zero opens an ascending sort with a screen of em-dashes, and
  on a merge-time column **zero is a real value that must outrank "no data"** --
  a test pins exactly that.
  **Status sorts on a rank, never on its text.** Alphabetical gives critical,
  healthy, needs-attention, which orders nothing. `BAND_SEVERITY` in `bands.ts`
  runs worst-highest so descending puts Critical on top like every other
  measure, and a band absent from the map sorts as missing rather than as
  healthy -- thresholds are configuration, so an unknown name is possible and
  ranking it 0 would present it as the healthiest thing on the estate.
  **There was no room for the sort carets.** Measured in the running page,
  seven of the productivity table's nine headings had zero or negative headroom
  after their 32px of padding -- `COMMITS` overflowed by 7px and was spilling
  into it, which `nowrap` under a fixed layout hides in silence. The caret is
  taken out of flow and laid over the padding, so it costs the heading no width
  and cannot reflow a fixed-layout column, and it sits on the side away from the
  values so a numeric heading stays aligned with its digits. Every header is a
  real `<button>` with `aria-sort` on the `th`; an `onClick` on the cell is how
  a hand-rolled sortable table ends up mouse-only.
- **The dashboard's default order buckets by ISO week, not by day, and the day
  bucket was too fine to work.** The rule was always "newest build first, worst
  score within it", and it was implemented correctly -- but 49 repositories have
  pipeline runs across **24 distinct days, 14 of which hold exactly one
  repository**, so for those the score half had nothing to rank. The newest day
  held one healthy repository, which put a 95 at the top of a dashboard whose
  stated job is to lead with what needs attention. The same runs fall into 14
  weeks, one holding 17, and `daarwyn-bo-ui` at 53 moved from row 8 to row 3.
  `utcWeek` in the router is Monday-start, matching `date_trunc('week', ...)` in
  `ProductivityStore` and the commit trend -- three places deciding
  independently when a week starts is how a dashboard and a report disagree.
  **A test would have rotted silently.** `orders by build day, newest first`
  used timestamps two hours and one calendar day apart that are the **same ISO
  week**, so after the widening it kept passing while being decided entirely by
  score, which happened to agree. It is a genuine week apart now with the newer
  repository the healthier one, so it fails if recency stops dominating.
- **The commit trend's tooltip named an instant for a period.** It read
  "3 Aug: 147 commits" on a weekly chart, which states that 147 commits landed
  on one day; the real figure was 147 across 3-9 August. `bucketRangeLabel`
  names both ends. **The chart has a second, unfixed problem:**
  `commitTrendByAuthor` is a `GROUP BY` with no zero-fill and
  `ProductivityService` just sorts the map, so a week with no commits produces
  no row and **no slot** -- bars that look adjacent may not be adjacent weeks,
  and the axis starts at first activity rather than at the window start.
  `CommitTrend` even has a dead branch giving zero buckets a hairline, with a
  comment explaining why, that `point.commits > 0` makes unreachable. See open
  decision 10.
- **`initialKind` and `initiallySelectedFilter` are INERT once you pass
  `filters`, and the failure is a catalog with no rows in it.**
  `DefaultCatalogPage` reads both only to construct its own `DefaultFilters`, in
  a `filters ?? <DefaultFilters initialKind initiallySelectedFilter ... />`. Our
  module **must** pass `filters` to host the filter extensions, so both props
  are discarded -- they typecheck, they read correctly, and they do nothing.
  It matters because the pickers, not the page, were setting those filters. With
  `catalog-filter:catalog/kind` and `.../list` disabled, nothing set them:
  the kind went unconstrained (Systems, Users and Groups joining the
  Components), and the user-list filter fell to its **`'owned'` default**, which
  on this estate matches nothing. The catalog rendered `0-0 of 0`.
  **The fix is two pickers mounted but not rendered**, in the `filters` slot:
  `<EntityKindPicker initialFilter="component" hidden />` and
  `<UserListPicker initialFilter="all" hidden />`. `hidden` is safe for this and
  it was checked rather than assumed -- both call `updateFilters` from an effect
  and only then test it, so `hidden ? null : <Select/>` gates the render and
  never the filter.
- **The catalog filter extensions are not named after what they show.** There
  are eight, declared in `plugin-catalog/dist/alpha/filters.esm.js`: `kind`,
  `type`, `lifecycle`, `tag`, `namespace`, `processing-status`, **`list`** (the
  Personal / Owned / Starred block, `UserListPicker`) and **`mode`** (the Owner
  dropdown, `EntityOwnerPicker`). **There is no
  `catalog-filter:catalog/owner`** -- an earlier note here said there was.
  `catalog-filter:catalog/list` also carries an `initialFilter` config key
  (`owned` | `starred` | `all`), so the Personal block can be retuned rather
  than removed.
- **There is no stock filter for the Bitbucket project, and
  `EntityAutocompletePicker` is how you build one.** None of the eight covers
  the System an entity belongs to, which this portal renders as Project.
  `packages/app/src/modules/catalog/EntityProjectPicker.tsx` is a filter class
  over `spec.system` plus that generic picker -- the same primitive the Tag and
  Owner pickers are themselves built from. `AllowedEntityFilters` requires the
  class expose `values: string[]`, and `DefaultEntityFilters` is generic, which
  is the documented way to add a key. Implement **both** halves:
  `getCatalogFilters` pushes the work to the backend, which offset pagination
  needs -- the page fetches 20 rows at a time, so a frontend-only filter would
  filter one page and report a wrong total.
- **A custom `renderOption` CAN keep the counts -- you just have to source them
  yourself. This corrects an earlier note here saying the two were mutually
  exclusive.** `EntityAutocompletePicker` applies `getOptionLabel` to the input
  text only, and hands a custom `renderOption` just `(option, state)`, so the
  counts it holds internally are out of reach. That much was right. The wrong
  conclusion was that labelling the options therefore costs the "(37)".
  `EntityProjectPicker` supplies **both** callbacks, backed by one request:
  `getEntities({ filter: { kind: 'System' } })` with `relations` in `fields`
  yields the title _and_ the count, because `hasPart` on a System lists its
  components -- 21/12/20/4/37/4, matching the facet exactly. A second
  `getEntityFacets` call was the first implementation and was removed as
  redundant; the guard against it drifting is a `component:` prefix test on the
  relation, since a future Resource would otherwise inflate the number.
  It degrades to the raw value while in flight or on failure, so the filter
  never breaks.
- **The catalog's `search` table lowercases every value, and reading it as
  ground truth is a trap.** It exists for case-insensitive matching, so querying
  it for the System titles returned `am`, `mdlh` when the entities actually
  carry `AM`, `MDLH`. Read `final_entities` and parse the JSON when the exact
  value matters. What is genuinely lower-case is `spec.system` itself: it holds
  the System's **name**, which `toSystemName` lowercases, while the Project
  column renders the **title**. The filter therefore offers `mdlh (37)` where
  the column shows `MDLH`, and that is deliberate --
  `EntityAutocompletePicker`'s `getOptionLabel` reaches the input text only, not
  the option rows, and a custom `renderOption` receives `(option, state)` with
  **no access to the counts**. Upper-casing costs the "(37)" on every row, which
  is worth more.
- **Two tables on a page are not necessarily a duplicate, and reading a
  concatenated header list as one cost a wrong diagnosis here.** Dumping every
  `thead th` on a project's page returned
  `[Name, Owner, Type, Lifecycle, Description, Name, Owner, Description]`, which
  looks exactly like a failed extension override rendering the stock card
  alongside its replacement -- and that is what it was written up as, wrongly.
  The first table was `entity-card:catalog/has-resources`, showing "No resource
  is part of this system" under the Resource column preset; the second was the
  replacement, with 37 rows. **Enumerate tables individually -- title, header
  set and body row count -- before concluding anything from a flattened list.**
  Overriding an entity card under the stock name does work; the disable in
  `app-config.yaml` is kept because naming the two separately is clearer, not
  because the override failed.
- **`HasComponentsCard` is not exported from anywhere public** -- only
  `HasComponentsCardProps` is, and the stock extension reaches the component
  through a deep dynamic import. So its `columns`/`columnConfig` props are
  unreachable. `packages/app/src/modules/catalog/hasComponentsCard.tsx`
  recomposes it from `EntityTable` + `useRelatedEntities`, both public and both
  what the stock card is built from, and overrides the extension by registering
  under the same `has-components` name. Keep its `filter: { kind: 'system' }`,
  or the card renders on every kind. It needs `tableLayout: 'fixed'`: measured
  on the MDLH project, the automatic algorithm laid the table out at **937px
  inside a 654px card**, pushing Description off the edge.
- **Our tables are hand-rolled HTML, so theme table rules do not reach them.**
  The shared styles live in `plugins/fleet/src/surfaces.ts` -- `cell`,
  `headerCell`, `chip`, `input`, `panel`, `tag` and friends -- and both Fleet
  pages import from there. Before that each file carried its own copy, and
  letting them drift is what made the catalog table and the fleet table look
  like different products.
  **`surfaces.ts` may only use CSS custom properties, never literals.**
  `plugins/fleet` cannot import from `packages/app` -- wrong dependency
  direction -- so a custom property is the single channel between the theme and
  these styles. It is also what makes them follow a light/dark switch with no
  React state: the browser resolves them at paint time.

- **Starring is gone, and it existed in exactly one place.** Swept before
  touching anything: the catalog, search, fleet, productivity and settings pages
  had no star control at all, and nothing in this repo's own code renders one --
  the table's star action left with the Actions column and the Starred filter
  with `catalog-filter:catalog/list`, which had already made
  `starredEntitiesApiRef` write-only. What remained was
  `FavoriteEntityButton` in `EntityHeaderBui`, neither an extension nor
  swappable, sharing `bui-HeaderControls` with the context menu -- so hiding the
  container was not an option.
  Matched on **`aria-label*="favorite" i`**, the only thing distinguishing it
  from the menu button, with the substring covering both states because the
  label toggles between "Add to" and "Remove from". Both spellings are listed
  since the wording comes from `catalogReactTranslationRef`. **The failure mode
  to expect: if a future Backstage renames those keys the rule stops matching
  and the star returns.**
  Verify this kind of change by computed style, not by DOM presence --
  `querySelector` finds a `display: none` element perfectly well, and a first
  check that way reported the star still there.
- **The source tree carries no dead code, and the second audit agreed with the
  first.** Re-audited 2026-09-08 across 114 source files: the only ones nothing
  imports are the five entry points and three `setupTests.ts`. No knip,
  ts-prune or depcheck is installed, and on this evidence that is no loss --
  both symbols that _looked_ removable were load-bearing. `techStack` reads as
  dead because the dashboard's Stack column went, and is still rendered by
  `RepositoryFactsCard`; `unmeasuredScorer` is unused in production and
  deliberately kept.
  **The one real find was CSS, and it was orphaned by this repo's own
  changes**: 78 lines styling the Owned/Starred filter rows, dead since
  `catalog-filter:catalog/list` was disabled. Proven before deleting by counting
  its three selector families against the live DOM over seven pages -- zero
  matches. A note in its place records the remedy it held, because the clipping
  it solved was not obvious.
- **The catalog page is the one page with no request-count assertion**, which is
  how two avoidable requests got added to it unnoticed. `performance.test.ts`
  pins the fleet endpoint at exactly 1 call and the entity page at 1; the
  catalog is only timed. Measured by hand at 19 API calls, 17 after collapsing
  the project picker's two lookups into one. Worth an assertion.
- **`color-scheme` was declared nowhere, and it is the only thing that tells a
  browser the page is dark.** Without it every piece of chrome the browser draws
  rather than the page came from the OS default: the `select` popup and its
  highlight, the scrollbar track and thumb, the dropdown caret, autofill, date
  and number spinners. The productivity page's repository dropdown opened as a
  mid-grey list with the Windows accent blue on the selected row, inside a
  near-black portal. Declared on `:root` as well as `body` -- the document
  scrollbar and the canvas hang off the root element, and this is the same trap
  as the token block, in a different guise.
  **The option list is only partly reachable, and the difference matters.**
  `color-scheme` is standard and carries every engine; a `background-color` on
  `option` is honoured by Blink and Gecko and **ignored by WebKit**, so it is a
  refinement on top rather than the fix. Its border, shadow and radius cannot be
  reached at all -- that would mean replacing the control with a listbox,
  keyboard navigation and ARIA included. Values there must be **opaque**: the
  popup is painted over whatever the window manager has behind it rather than
  over the page, so `surface[3]`, the raised-ground token it would otherwise
  take, composites against something unknowable.
  Verified live 2026-09-03 rather than reasoned about: dark mode computes
  `color-scheme: dark` on root, body and the select, `option` background
  `rgb(17, 24, 35)` and colour `rgb(230, 237, 245)`. **A Playwright screenshot
  cannot show the open popup** -- it is drawn by the OS outside the page's
  compositing surface -- so the computed values are the evidence, and the open
  list is the one thing here only a person can confirm.
- **`globalCss` is a template literal, so a backtick in a CSS comment ends the
  string.** This has now broken the build **four** separate times -- the fourth
  by the author of this very note, in this very file's neighbour, while
  documenting a CSS change. Always the same way:
  writing `` `body` `` or `` `spacing` `` inside an explanatory comment. The
  failure is a swc parse error pointing at the comment, not at anything CSS.
  Use plain quotes inside that string.
  The deprecated-token lint rule reads the whole literal as CSS too, so a
  comment **naming** a deprecated token warns exactly as a declaration using it
  does -- the note explaining why those tokens are deliberately absent has to
  describe them without spelling them.
- **`BackstageTable` is EVERY core-components table in the portal, so a
  positional rule under it reaches tables you were not thinking about.** The
  catalog's `th:last-child { width: 1% !important }` exists to make Tags hug its
  chips, and unscoped it crushed the last column of every other table too: the
  Repositories card on a project page rendered Owner at **7px**, exactly 1% of
  its 654px card. It was misdiagnosed twice on the way -- first as
  material-table's equal split, then as an unfixable narrow card, and a useful
  Description column was deleted to work around it before the real cause
  surfaced. **A column at exactly 1% of its container is a stylesheet claiming
  it, not a layout algorithm failing.** The rule is scoped to
  `[class*="MuiGrid-grid-lg-10"]` now -- `CatalogFilterLayout`'s content column,
  which no other page has.
- **Backstage UI sets `align-items` and `gap` on elements that are
  `display: inline-block`, where both are inert.** The owner's avatar and name
  in an entity header declared `gap: 8px` and centring, and had neither:
  measured, the avatar ended at x=321 and the name began at x=321, with vertical
  position coming from inline baseline metrics. `display: inline-flex` on that
  link -- inline, so it does not claim the row -- activates BUI's own values and
  needs none of ours. Gap became 8px and the vertical offset âˆ’0.3px.
  Worth checking whenever a BUI row looks a pixel or two out: the properties may
  be declared and doing nothing.
- **`[class*="MTableToolbar"]` matches four elements, not one** -- the toolbar,
  its title, its spacer and its actions -- so padding applied through it lands
  four times. Adding 20px to align a card title with its own first column inset
  the title by 41px instead of 21. `BackstageTableToolbar-root` is the precise
  key. The rule exists because material-table's toolbar carries
  `padding: 4px 0px 12px`, no horizontal padding at all, so a card title sat 1px
  from the border while its header row sat at 21px. **Only one table in the
  portal has that toolbar** -- the catalog renders its own heading outside the
  table, measured as no `MTableToolbar` on the page, and the fleet tables are
  hand-rolled.
- **Duplicate object keys in a `styleOverrides` block silently replace, not
  merge.** `BackstageTable` had two `'& th, & td'` entries and the second threw
  away the first's `width: auto !important`, taking the catalog straight back to
  material-table's equal-split. Anything reaching every cell goes in one block.
- **`PageLayout` is swapped, because it cannot be themed.** Every routed page is
  wrapped by `PageBlueprint` in `PageLayout`, whose stock implementation sets
  `backgroundColor: '#fff'` and `borderBottom: '1px solid #ddd'` as **inline
  styles** -- unreachable by a MUI theme, by BUI tokens, and by CSS. The dark
  theme had a white bar across the top of every page. It is built with
  `createSwappableComponent`, so `SwappableComponentBlueprint` (from
  `@backstage/plugin-app-react`, already a dependency) replaces it properly:
  `PortalPageLayout` reimplements the whole `PageLayoutProps` contract.
  Its blueprint needs the `defineParams` callback form; a plain object literal
  is a type error, because the blueprint infers prop types from the ref.
- **material-table writes inline widths on every cell, and they are an equal
  split.** Measured in the running app: `width: calc(267.75px)` on Name, Project
  and Owner alike, so `Project` holding "AM" got the same room as a name like
  `daarwyn-back-office-services`, which then wrapped and made that row twice its
  neighbours' height. The count it divides by does not account for columns
  hidden in CSS and no prop corrects it, so the theme resets them to `auto` --
  `!important` is not decoration there, an inline style admits nothing else.
- **The Fleet tables use `table-layout: fixed` with an explicit `<colgroup>`.**
  The automatic algorithm balances column widths against content, so one long
  value changes a column for all 96 rows and it will break "Needs attention"
  across two lines to buy a neighbour room. Fixing the layout is also what makes
  `text-overflow: ellipsis` work at all -- under the automatic algorithm a
  cell's minimum width is its content's, so `nowrap` grows the column instead of
  truncating. Percentages live in one `COLUMNS` array per page and total 100.
  **Do not "fix" a wrapping column by adding `nowrap` to its neighbours**: that
  was tried, and it moved the problem rather than solving it -- the short
  columns took the space and Contributors went from two lines to three.
- **The catalog's filters are a band above the table, not a column beside it,
  and the height came from four places at once.** Two filters down the left of a
  1900px page left that column empty while squeezing the table into 83% of the
  width. `CatalogFilterLayout` is a bare `Grid` with the filters at `lg={2}` and
  the content at `lg={10}`, so giving both `flex-basis: 100%` and
  `max-width: 100%` makes the table wrap below -- **the wrap used to be the
  hazard and is now the mechanism**. Both need `max-width`: MUI pins
  16.666667% and 83.333333% on those classes and a flex-basis alone is clamped.
  Behind `@media (min-width: 1280px)` because below it `Filters` renders a
  button and a drawer rather than a grid item, and that path must stay
  untouched.
  Getting it from **136px to 64px** took four changes and only one was padding:
  32px of card padding, 16px on each picker's own Box, another 16px of margin
  inside it, and **`margin-top: 24px` on the input** -- Material UI's
  reservation for a label sitting above a control.
  **That 24px and the label's `position: absolute` are a pair.** The picker
  absolutely positions its label INTO the space the margin reserves, so zeroing
  the margin without also setting `position: static` left the label out of flow,
  overlapping the input and invisible behind its background -- a 64px band with
  no "Owner" or "Tags" on it. Out of flow it also ignored every flex property,
  which is why setting `flex` on it alone changed nothing.
  **And a label and its control are not interchangeable flex items.** One
  `label > *` rule giving both `flex: 1 1 auto; min-width: 0` let the text span
  shrink to zero against a control that wanted more width, which is what erased
  the labels in the first place. The text is `flex: 0 0 auto`; only the control
  flexes, and only it takes `min-width: 0`.
- **Reserved secondary-action gutters clip labels, twice now.** MUI reserves
  48px of right padding on any `ListItem` carrying a secondary action, sized for
  an icon button. In the catalog's 134px filter column, where the action is a
  one-character count, "Owned" and "Starred" rendered as "Owne" and "Starre".
  Same failure as the sidebar rows reserving 56px for submenu arrows that never
  render, and the same remedy: size the gutter to the content.
- **Backstage UI's `Header` is three sibling containers, not one element** --
  `bui-HeaderTop`, `bui-HeaderContent`, `bui-HeaderBottom`. On the catalog page
  all three are dead weight, because `PortalPageLayout` renders the page title
  now and the catalog's own is blanked through the translation ref. Collapsing
  only the middle one leaves `HeaderBottom`'s 20px margin behind.
  Getting the condition right took three attempts, all from assuming rather than
  measuring: `HeaderContent` has two children, not one, and the controls slot
  beside the title holds a support-button wrapper that renders at 0x0. The
  working test is for a non-`:empty` descendant -- which also means the header
  reappears by itself the moment a support URL is configured.
- **`palette.secondary` is not decorative: the relations graph fills its focused
  node from `secondary.light` and labels it from `.contrastText`.** Backstage's
  dark palette sets `secondary.main` to `#FF88B2`, so the entity you were
  looking at rendered as a bright pink pill among emerald ones on every entity
  page. Neither `light` nor `contrastText` is declared upstream, so MUI derived
  them; the portal sets all three from `accent.alt`.

- **A tie is never an owner.** Two people on half the commits each clear a 50%
  share threshold; the resolver additionally requires the leader to be strictly
  ahead of the runner-up. Three tests fail if that rule is removed.

- **A dependency scan cannot decide what this repo may delete.** Audited
  2026-09-02: the graph from the five real entry points reaches all but **one**
  of 156 source files, so the source tree is clean and the dead weight was in
  `package.json` and config. But the scan's "unused" list was mostly wrong, and
  each wrong entry breaks something different:

  - **`@internal/backstage-plugin-fleet` is imported by nothing.** It reaches
    the app purely through `app.packages: all`, exactly as the scaffolder did.
    Removing it deletes the Fleet and Productivity pages silently.
  - **`@backstage/plugin-signals` contributes only an `ApiBlueprint`**, which
    reads as filler. It provides the `signalApiRef` factory that
    `plugin-app-module-user-settings` needs to build the server-backed
    `storageApiRef`. Drop signals and **user-settings persistence** breaks, not
    just notifications. If notifications ever go, signals still stays.
  - `pg`, `better-sqlite3` and `app` are resolved **by name at runtime** (knex,
    and `plugin-app-backend` serving the built frontend). `config.d.ts` is
    reached through `"configSchema"`. `@types/*` are type-only.
  - `@testing-library/dom` is a declared **peer of `user-event`**, which
    `plugins/fleet` uses -- so it stays there and goes only from `packages/app`,
    where `user-event` went too.
    Actually removed: 16 dependencies across the three packages, of which the only
    interesting ones are `@backstage/integration-react` (role `web-library`, so
    never discovered -- import is its only route in) and `core-components`/`theme`
    from `plugins/fleet`, which renders entirely in BUI.

- **Do not verify a frontend change by grepping the bundle for a route id.**
  `page:fleet/productivity` and `api/fleet` are **constructed at runtime**, not
  literals, so they do not appear in `dist/static/*.js` and their absence proves
  nothing. Grep for a string the plugin actually ships -- the
  `fleet.backstage.io/bitbucket-slug` annotation constant, or a rendered label
  like "Health score" -- and expect the three fleet surfaces in **lazy chunks**,
  not in `main.js`.

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
  `ScorerOutcome.remediation` is optional and every registered scorer supplies
  its own, because the fix almost always quotes a **configured** value -- the
  recency threshold, the discipline window, the exemption key -- and a frontend
  lookup table would duplicate config and drift silently the moment someone
  tuned it. A test proves it: `mainBranchCurrentScorer({ bands: [...14 days] })`
  says "every 14 days", not a hardcoded 30.
  **It must never quote absolute points**, only day thresholds and shares. Two
  scorers did and were wrong on the page the moment the interim weights landed;
  the weight is configurable, so a figure is a claim the scorer cannot keep.
  The engine drops remediation at full marks, so it never travels beside a
  metric that lost nothing. The recency scorers deliberately stay **silent**
  for a repository with no commits at all, because "commit more" answers
  neither the scaffold case nor the abandoned one -- the card reports that as
  dormancy instead.
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
  So `plugins/fleet-common/src/problems.ts` folds the activity-derived metrics
  into a single dormancy statement whenever the activity metric is zero: they
  are one fact wearing several hats, and a dormant repository scores zero on all
  of them by construction. `ACTIVITY_DERIVED` and `ACTIVITY_METRIC` hold the ids
  and have had to move twice as metrics were replaced -- see the note on
  `deriveProblems` keying dormancy on an id. Dormancy is then phrased by history
  -- `portal-ui` with 276 lifetime commits reads "abandoned", a four-commit
  scaffold reads "never really developed. Not a decaying service." Absent
  lifetime data assumes never-started, because that is the less alarming of the
  two guesses.
  Unmeasurable metrics are listed separately and never counted as problems: 54
  repositories cannot be judged on code review or pull request size at all.
  **The payoff is that the biggest actionable problems are cheap ones.**
  Measured 2026-09-09 after the rule rewrite: README on 35 repositories,
  code review on 39, stale branches on 20 -- where the old flat list buried
  them beneath four larger numbers nobody could act on.
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
  **The scaffolder removal missed `app-config.production.yaml`, and nothing
  caught it for six days.** That file still declared a `catalog.locations` entry
  for `examples/template/template.yaml` -- a path deleted with the scaffolder --
  under `rules: [allow: [Template]]`, a kind the catalog no longer understands
  since `plugin-catalog-backend-module-scaffolder-entity-model` went. Every
  check in CI passes on it, because **no check loads the production config**:
  `yarn tsc`, `lint:all`, `prettier:check` and `yarn test` all read
  `app-config.yaml` or nothing at all. Fixed 2026-09-02. When a feature is
  removed, grep `app-config.production.yaml` too -- it is the one config that
  only a deploy exercises.

- **`examples/` is two files with opposite fates, and the folder name lies about
  both.** `entities.yaml` was pure scaffolding -- an `examples` System, an
  `example-website` and an `example-grpc-api`, all owned by `guests` -- and was
  deleted 2026-09-02 along with its location entry in both configs. `org.yaml`
  is **load-bearing production data**: it carries `sahilotavanekar`, which the
  `usernameMatchingUserEntityName` resolver matches a GitHub login against, and
  the `unowned` group the entire ownership backlog is counted against. Deleting
  the folder wholesale breaks sign-in and orphans 5 repositories.
  Also removed as inert the same day: the root `catalog-info.yaml` (still
  self-described as "An example of a Backstage application", and in no
  `catalog.locations`), `plugins/fleet-backend/src/bitbucket/index.ts` (a barrel
  nothing imported), and `plugins/fleet-backend/scripts/` -- three one-off
  backfills that repaired rows predating a column, and so can no longer fire
  usefully: a database built fresh ingests those fields natively.

- **Kubernetes, notifications and the app visualizer are removed. Signals is
  not, and that is the whole point.** Dropped 2026-09-02: all three were wired
  end to end and none had anything to act on.

  - **Kubernetes could not have rendered.** `entity-content:kubernetes` is gated
    on `filter: isKubernetesAvailable`, which wants the
    `backstage.io/kubernetes-id` annotation; `BitbucketRepositoryEntityProvider`
    never emits it and the `kubernetes:` config block was empty, so the tab was
    unreachable on all 97 entities. Frontend plugin, `plugin-kubernetes-backend`
    and the config block all went.
  - **Nothing in the codebase emits a notification**, and the page was already
    taken-and-discarded in `Sidebar.tsx`. Frontend and backend both went.
  - **`@backstage/plugin-signals` stays**, and must. It contributes only an
    `ApiBlueprint`, so it reads as filler that should have gone with
    notifications -- but it provides the `signalApiRef` factory that
    `plugin-app-module-user-settings` needs to build the server-backed
    `storageApiRef`. Removing it breaks **user-settings persistence**, which
    has nothing to do with notifications and would look unrelated.
    Verified against a clean rebuild: `kubernetes` and `app-visualizer` appear in
    **0** bundle files and `page:notifications` in none; the 5 remaining
    `notification` hits are `hasNotifications`, a `SidebarItem` prop from
    `core-components`. `signal` still appears in 13.

- **`proxy:` and `integrations.github` were config that configured nothing.**
  Both removed 2026-09-02. `proxy:` held only commented examples and parsed as
  `null`; `plugin-proxy-backend` is still loaded and starts without it.
  `integrations.github` fed no consumer -- GitHub sign-in reads
  `auth.providers.github`, a different key, and no catalog location points at
  github.com.
  **What that exposed is the real problem: `integrations.bitbucketCloud` is the
  portal's most load-bearing config and is not in any committed file.**
  `fleetPlugin` reads it through
  `ScmIntegrations.fromConfig(config).bitbucketCloud.byHost('bitbucket.org')`
  and refuses to run ingestion without it, yet a fresh clone gets no hint it
  exists -- the committed config advertised the credential nothing used and
  omitted the one everything needs. `app-config.yaml` now carries a comment
  block saying so. A `${...}` placeholder was deliberately **not** added: an
  unset env var makes Backstage drop the key, which would turn a clear "no
  integrations.bitbucketCloud entry" error into a schema failure on a
  half-built list entry.

- **`config.d.ts` said `email` was required; everything else said optional.**
  `RegisteredEngineer.email` is documented optional, `catalog/identity-register.yaml`
  omits it for `saideep-narayan-avhad` on purpose, and only the config schema
  disagreed -- so `backstage-cli config:check --strict` failed on a register the
  portal reads happily at runtime. Fixed 2026-09-02.
  **No test would ever have caught this**: nothing in the suite loads a real
  `app-config`. `yarn backstage-cli config:check --config app-config.yaml
--config app-config.local.yaml --strict` is the check that does, and it is
  worth running after any `config.d.ts` or register change.

- **There is nothing worth un-exporting, and the "unused exports" are a test
  gap wearing a disguise.** A scan found 67 symbols referenced only inside their
  own file, which reads like surplus API. Examined individually: every one names
  the parameter or return of an exported class or function -- `*Options`,
  `*Props`, `*Row` -- so un-exporting them removes a caller's ability to name
  the type and gains nothing. The three that genuinely are internal point
  somewhere more useful: they were exported so a test could reach them, and no
  test had. **Written 2026-09-02, and the gaps are closed** -- `catalog.test.ts`,
  `catalogReact.test.ts` and a `productivityPage` block in `plugin.test.tsx`,
  14 tests taking the suite from 817 to 831. `productivityPage` had shipped
  unpinned against the every-page convention above; the icon guard was
  mutation-tested by deleting `icon: <GroupIcon />` and confirming it, and only
  it, failed.
  So: do not "clean up" an export that looks unused here. Check whether a test
  should be reaching it first.

- **`toHaveProperty` reads a dot as a path separator, and every translation key
  has one.** `expect(messages).toHaveProperty('indexPage.title')` looks for
  `messages.indexPage.title` **nested**, not for the literal key, so it fails
  against `{'indexPage.title': ''}` -- which is exactly the shape
  `createTranslationMessages` produces. Both new i18n tests failed on this
  first. Use `expect(Object.keys(messages)).toContain('indexPage.title')`.
  Asserting presence matters and cannot be skipped: an **absent** key falls
  through to the plugin default, so for `catalog.ts`, whose whole purpose is to
  blank a heading, `messages['indexPage.title'] === ''` and "key missing
  entirely" are opposite outcomes that a value-only assertion cannot tell
  apart.

- **Requirement 8 delivers eight of its ten measures, and there are now two
  routes to the ninth at very different prices.** Lines added and deleted come
  from two separate diffstat endpoints:
  - **Per pull request**, `/pullrequests/{id}/diffstat` -- **built and swept**,
    one request each, 391 for this estate. `pull_request.lines_added` and
    `lines_removed` are populated for every merged pull request, and a pull
    request carries an author, so **per-engineer line counts are derivable with
    no new requests at all**.
  - **Per commit**, `/diffstat/{sha}` -- verified working, never built, at one
    or more requests per commit: about **4,000** against ~500 for a full sweep.
    This is the only thing open decision 5 is still about, and it buys accuracy
    on commits that never went through a pull request.
    **Filtering by Team has no data source at all**, not merely deferred.
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

|     | Decision          | Outcome                                                                                                                              |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Bitbucket flavour | **Cloud** (Pipelines is Cloud-only)                                                                                                  |
| 4   | CI/CD system      | **Bitbucket Pipelines** — same API, same credentials, same quota                                                                     |
| —   | Dev database      | Postgres 16 in Docker; managed Postgres for production                                                                               |
| —   | Auth sequencing   | Entra ID deferred to the **end** of the build                                                                                        |
| —   | Config placement  | Postgres in `app-config.yaml` with `${...}`; values in `app-config.local.yaml`                                                       |
| 9   | §9 numbering gap  | **Not a requirement** — confirmed by the product owner; do not track it                                                              |
| 2   | Score bands       | **Four, specified:** Excellent 90-100, Healthy 75-89, Needs Attention 60-74, At Risk <60                                             |
| —   | Scorecard metrics | **The requirement's seven rules only**, at its weights. Contributors / pipeline / ownership unregistered 2026-09-09                  |
| 11  | PR size statistic | **Median**, not the specification's mean — the mean scored release mechanics, not review burden. Set in `app-config.yaml` 2026-09-10 |

### Open

|     | Question                                                                                                                   | Blocks                                                 |
| --- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 3   | Is §6 health and §7 scorecard one score or two?                                                                            | Scoring design                                         |
| 5   | Keep or drop lines added/deleted **per commit** (per-PR is now built)                                                      | Productivity dashboards                                |
| 6   | Who may see whose productivity data                                                                                        | Productivity dashboards                                |
| 7   | Business Owner / Business Unit source of record; retention period                                                          | Ownership fields                                       |
| 8   | Should branch divergence be scored? Needs a weight rebalance                                                               | The 7 metrics total exactly 100                        |
| 9   | Filter deliberate long-lived branches out of **divergence** — settled for scoring, where `staleBranches.exempt` handles it | ~750 of 2,699 stranded commits                         |
| 10  | Commit trend: zero-fill from the window start, or from first activity?                                                     | The per-engineer chart's x-axis is not continuous time |

### Deferred as later add-ons

Business Owner/Unit fields, the security-scan scorer, Entra ID + RBAC.

Productivity dashboards (§8) are **built**, not deferred -- eight of the ten
measures, with lines added/deleted and Team filtering (no data source) the two
absences. **The per-pull-request diffstat now exists**, so §8's lines
added/deleted is no longer blocked on the API, only on attributing lines to a
_person_: a pull request carries an author, so per-engineer totals are
derivable from `pull_request.lines_added` without a single new request. Open
decision 5 is now only about per-**commit** lines, which still costs ~4,000
requests. What is still missing from §8 is **access control**: see open
decision 6, and treat it as
blocking before anyone outside the team sees per-person figures.

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
- **`ProductivityStore` has no test file, and its SQL is Postgres-only.** It
  uses `date_trunc`, which SQLite does not have, so the unit harness has never
  exercised it -- which is why nothing caught that until the adaptive bucketing
  work extended it. `bucketForWindow` is pure and tested; the queries are only
  exercised by the running app.
- **Every visual change needs a browser -- and there is one.** This corrects an
  earlier note here that said otherwise. Playwright is already installed, and
  the dev server can be driven headlessly without restarting it
  (`reuseExistingServer: true` in `playwright.config.ts`): sign in through the
  guest **Enter** button, then screenshot, measure geometry with
  `getBoundingClientRect`, or tab through and read `document.activeElement`.
  Theme switching is **not** a localStorage flip -- user settings are
  server-backed here -- so drive it through the buttons on `/settings`.
  Use it. Three defects this session were invisible to every other check and
  obvious in one screenshot: a bright pink graph node on every entity page,
  filter labels clipped to "Owne", and a search field on top of a heading at
  390px. Measure rather than reason: the catalog's column widths, the BUI
  header's three containers and the 48px list gutter were each diagnosed wrong
  at least once from assumption, and right immediately from the DOM.
  Verify pinned _and_ unpinned, and at least one narrow viewport. The current
  sweep is 6 viewports x 3 pages, asserting `scrollWidth === clientWidth` --
  sideways scroll is the specific failure that has bitten this repo twice.
  **Distrust the instrument before the result, and two of these cost real
  time.** Creating a Playwright page at a given `viewportSize` and then
  navigating does **not** re-evaluate `useMediaQuery`: a sweep reported
  identical geometry at 1600, 1000 and 900px, including a 1008px element inside
  a 900px viewport, which is impossible. `page.setViewportSize` on a live page
  is what actually re-lays-out. And `netstat` prints the port **before** the
  state, so `grep "LISTENING.*:7007"` can never match -- that pattern produced
  a confident diagnosis that the backend was down while it was serving 200s.
  If a measurement is impossible, the measurement is wrong.
  **A third instrument failure, and it reports success:** guarding the guest
  sign-in with `if (await enter.isVisible())` **silently skips it** on a fresh
  page, because the button has not rendered when the check runs and
  `isVisible` does not retry. The run then measures the sign-in page --
  `SEGMENTS []`, `STATUS COLUMN []`, no theme buttons -- which reads exactly
  like a component that failed to render, and cost two rounds of debugging the
  wrong thing. Always `await enter.waitFor({ state: 'visible' })` first.
  Two lesser notes on driving it from a script rather than the test runner:
  `playwright.config.ts` restricts `testDir` through `generateProjects`, so a
  spec outside the package is "No tests found" -- use `chromium.launch()`
  directly. And a scratchpad script cannot resolve `@playwright/test`, so
  require it by absolute path out of the repo's `node_modules`.
- Test coverage is no longer thin -- 1,123 tests across 57 suites -- but it is
  uneven: `ProductivityStore` still has no test file (see below), and nothing in
  the suite loads a real `app-config`. New modules ship with tests.
  **`BranchStore` was the same kind of gap and is now closed**: it had no test
  file at all until 2026-09-09, having been exercised only through
  `RepositoryDetailIngestionService`, so its default-branch exclusion had no
  coverage of its own. Worth checking for others: a store reached only through a
  service is tested by accident, not on purpose.
- The Bitbucket credential in use belongs to an individual, not a service
  account. Synchronization will break if that person's access changes.

## Working agreement

Development is deliberately incremental: understand, plan, ask, implement one
small step, test, verify, report. Do not assume requirements, schemas, APIs,
credentials or behaviour that has not been confirmed. Distinguish clearly
between **verified** and **not yet verified**. Ask before architectural or
irreversible changes. Do not commit or push unless asked.
