# fleet-backend

Ingests the Bitbucket Cloud estate, scores it, resolves ownership, and serves
`/api/fleet`.

## Structure

| Directory       | What lives there                                                      |
| --------------- | --------------------------------------------------------------------- |
| `bitbucket/`    | `BitbucketClient` interface, the Cloud adapter, and a fake for tests  |
| `ingestion/`    | Repositories, commits, pull requests, pipelines, deployments          |
| `database/`     | One store per table; migrations in `migrations/`                      |
| `analysis/`     | Branch policy, branch divergence, tech stack, entity classification   |
| `ownership/`    | Resolver chain — register, then admin permission, then commit history |
| `scoring/`      | The engine and the eight registered scorers                           |
| `catalog/`      | Entity providers for repositories and commit authors                  |
| `productivity/` | Per-engineer rollups                                                  |
| `search/`       | Collator factory for the search index                                 |

Nothing downstream imports the Bitbucket API directly — everything goes through
the typed `BitbucketClient` interface, which describes what the portal needs
rather than what the API returns.

Scoring is a registry of independent scorers. Weights and band thresholds live
in **config, not code**, which is what makes a deferred metric a pluggable slot
rather than a refactor.

## Config

Declared in [config.d.ts](config.d.ts) and registered through the
`"configSchema"` field — not by import, so do not remove that file because a
dependency scan calls it unreachable. Workspaces must be listed explicitly:
Atlassian removed the workspace enumeration endpoints (CHANGE-2770), so they
cannot be discovered.

```yaml
fleet:
  bitbucket:
    workspaces: [demandai]
  ownership:
    register: { $include: ./catalog/ownership-register.yaml }
  identity:
    register: { $include: ./catalog/identity-register.yaml }
```

## Migrations

**Never edit a migration that has already run.** Knex records them by filename,
so an edit is silently a no-op against any database that already applied it —
unit tests still pass, because they migrate a fresh database every time, and
only the live run fails. Add a new migration instead.

## Tests

```sh
CI=true yarn workspace @internal/backstage-plugin-fleet-backend test
```

`startFleetTestDatabase` boots the plugin against a throwaway database so tests
exercise the real migrations rather than a hand-built schema.
