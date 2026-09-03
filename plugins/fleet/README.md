# fleet

The portal's frontend plugin: the fleet dashboard, the productivity page and the
entity cards that sit on a repository page.

Built with the **new frontend system** — `createFrontendPlugin` and blueprints
(`PageBlueprint`, `EntityCardBlueprint`, `NavItemBlueprint`) in
[src/plugin.tsx](src/plugin.tsx). The `createPlugin` + JSX routes API that most
Backstage tutorials show does **not** work here.

## Extensions

| Extension                            | Where it appears                                          |
| ------------------------------------ | --------------------------------------------------------- |
| `page:fleet`                         | Fleet dashboard — every repository, scored and filterable |
| `page:fleet/productivity`            | Per-engineer commit, pull request and review figures      |
| `entity-card:fleet/repository-facts` | Repository page — score breakdown, problems, activity     |
| `entity-card:fleet/about`            | Repository page — replaces the stock catalog About card   |

A page extension needs a **route ref, a title and an icon** to appear in the
sidebar. `AppNav` discards any page missing one of the three, silently — the
page still routes and still renders when visited directly, it just never shows
up in the nav. [src/plugin.test.tsx](src/plugin.test.tsx) pins all three.

## Conventions

Rendering is [`@backstage/ui`](https://backstage.io/docs/getting-started/ui)
(BUI), not `core-components` or MUI, so MUI theme overrides do not reach these
cards. The dashboard tables are hand-rolled HTML with a local
`headerCell`/`cell` matching the theme's `MuiTableCell` by hand; keep them in
step with the catalog table when either changes.

`min-width: 0` is load-bearing on the table scroll wrappers. A flex child
defaults to `min-width: auto`, so an `overflow-x: auto` wrapper grows to its
content instead of scrolling, and the whole page scrolls sideways.

## Installation

Reaches the app through `app.packages: all` discovery, from the dependency in
`packages/app/package.json` — nothing imports it. Removing that dependency is
what removes the pages.
