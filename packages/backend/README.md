# backend

The Demand AI Engineering Portal backend. Built on the **new backend system** —
`createBackend()` in [src/index.ts](src/index.ts), with every plugin added
through `backend.add()`.

## What it runs

Stock Backstage plugins: app, proxy, auth (GitHub + guest), catalog, permission
(`allow-all-policy`), search (Postgres engine, catalog collator), user settings,
signals and MCP actions.

**Signals is kept although notifications are gone.** It looks like filler — it
contributes only an API — but `plugin-app-module-user-settings` builds the
server-backed `storageApiRef` out of `signalApiRef`, so removing signals breaks
settings persistence rather than anything to do with notifications.

Then the portal's own:

- `@internal/backstage-plugin-fleet-backend` — Bitbucket ingestion, scoring,
  ownership resolution and the `/api/fleet` routes.
- `catalogModuleBitbucketRepositories` — the entity provider that enumerates the
  Bitbucket estate into Components and Systems.
- `searchModuleFleetRepositories` — indexes repository facts for search.

Those last two are **named exports**, so they are passed to `backend.add()`
directly rather than as dynamic imports: `backend.add()` unwraps `.default` from
a promise, which a named export does not have.

## Notes

`pg` and `better-sqlite3` are resolved by knex **by name** at runtime and are
never imported — do not remove them because a dependency scan calls them unused.
The same is true of `app`, which `plugin-app-backend` resolves to serve the
built frontend.

## Docker

Build from the repo root, not from here, and build the bundle first:

```sh
yarn install --immutable
yarn tsc
yarn build:backend
yarn build-image
```
