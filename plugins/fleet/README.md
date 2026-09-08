# fleet

The portal's frontend plugin: the health dashboard, the productivity page and
the entity cards that sit on a repository page.

Built with the **new frontend system** — `createFrontendPlugin` and blueprints
(`PageBlueprint`, `EntityCardBlueprint`, `NavItemBlueprint`) in
[src/plugin.tsx](src/plugin.tsx). The `createPlugin` + JSX routes API that most
Backstage tutorials show does **not** work here.

## Extensions

| Extension                            | Where it appears                                           |
| ------------------------------------ | ---------------------------------------------------------- |
| `page:fleet`                         | Health dashboard — every repository, scored and filterable |
| `page:fleet/productivity`            | Per-engineer commit, pull request and review figures       |
| `entity-card:fleet/repository-facts` | Repository page — score breakdown, problems, activity      |
| `entity-card:fleet/about`            | Repository page — replaces the stock catalog About card    |

A page extension needs a **route ref, a title and an icon** to appear in the
sidebar. `AppNav` discards any page missing one of the three, silently — the
page still routes and still renders when visited directly, it just never shows
up in the nav. [src/plugin.test.tsx](src/plugin.test.tsx) pins all three for
both pages.

## Source map

| Path                           | What it is                                                      |
| ------------------------------ | --------------------------------------------------------------- |
| `plugin.tsx`                   | Every extension, and the plugin's `routes`                      |
| `routes.ts`                    | The two route refs. Load-bearing — see the sidebar rule above   |
| `surfaces.ts`                  | Shared style objects. The single source for table and chip look |
| `components/FleetPage/`        | Dashboard table plus `FleetFilters`                             |
| `components/ProductivityPage/` | Table, and `sorting.ts` — the comparator, separately tested     |
| `bands.ts`                     | Score → band label, text and fill                               |
| `filter.ts`                    | Dashboard filtering and the counts the chips show               |
| `periods.ts`                   | "This quarter" → explicit UTC `since`/`until`                   |
| `format.ts`                    | `timeAgo`, `formatHours`, `formatBytes`                         |
| `useRepositoryFacts.ts`        | Fetches one entity's facts for the cards                        |

Problem derivation is **not** here — it lives in `fleet-common`, because the
overview endpoint and the repository card both classify problems and two
implementations would eventually disagree about what is wrong with a repository.

## Conventions

**Rendering is [`@backstage/ui`](https://backstage.io/docs/getting-started/ui)
(BUI), not `core-components` or MUI**, so MUI theme overrides do not reach these
pages or cards. Neither package is a dependency any more.

**Shared styles live in [`src/surfaces.ts`](src/surfaces.ts)** — `cell`,
`headerCell`, `chip`, `select`, `panel`, `tag` and friends. Both pages import
from there. Each file used to carry its own copy, and letting them drift is what
made the catalog table and the fleet table look like different products.

`surfaces.ts` may only use CSS custom properties, never colour literals. This
plugin cannot import from `packages/app` — wrong dependency direction — so a
custom property is the single channel between the theme and these styles. It is
also what makes them follow a light/dark switch with no React state.

**The tables use `table-layout: fixed` with an explicit `<colgroup>`**, and the
percentages in each page's `COLUMNS` array total 100. The automatic algorithm
balances columns against content, so one long value changes a column for every
row, and it will break a heading across two lines to buy a neighbour room.
Fixing the layout is also what makes `text-overflow: ellipsis` work at all.
Do not "fix" a wrapping column by adding `nowrap` to its neighbours — that was
tried, and the short columns simply took the space instead.

**`min-width: 0` is load-bearing on the table scroll wrappers.** A flex child
defaults to `min-width: auto`, so an `overflow-x: auto` wrapper grows to its
content instead of scrolling, and the whole page scrolls sideways.

## The productivity table sorts in the browser

Deliberately. The whole per-engineer breakdown arrives in one response of about
4KB with no pagination, so every row is already in the browser — a server sort
would add a query parameter and a refetch per click to reorder a list of
thirteen, and put a network round trip inside the two-second page-load budget
for no gain.

The comparator lives in
[`components/ProductivityPage/sorting.ts`](src/components/ProductivityPage/sorting.ts)
rather than in the page, so it can be tested without rendering anything. Two
things it gets right that a default sort does not: `undefined` is not treated as
zero (an engineer who has never merged a pull request is not the fastest
merger), and the unsorted state is the server's own ranking, not a column.

Headings are `<button>` elements, not click handlers on `<th>`. A bare `onClick`
on a cell cannot be reached by keyboard and is announced as nothing, which is
the usual way a hand-rolled sortable table becomes mouse-only.

## Installation

Reaches the app through `app.packages: all` discovery, from the dependency in
`packages/app/package.json` — **nothing imports it**. Removing that dependency
is what removes the pages, silently.

## Tests

```sh
CI=true yarn workspace @internal/backstage-plugin-fleet test
```

Visual changes need a browser, not reasoning: Playwright is installed and
`playwright.config.ts` sets `reuseExistingServer`, so a running `yarn start` can
be driven headlessly. Check at a narrow viewport too — sideways scroll is the
specific failure that has bitten these tables twice.
