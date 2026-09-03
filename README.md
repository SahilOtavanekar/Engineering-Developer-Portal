# Demand AI Engineering Portal

An Internal Developer Portal built on [Backstage](https://backstage.io). It
catalogs the organization's Atlassian Bitbucket Cloud estate and reports
ownership, repository health and engineering productivity.

Repositories are **enumerated from the Bitbucket API**, not discovered from
`catalog-info.yaml` files — none of the estate has one. A custom entity provider
synthesizes a Component per repository and a System per Bitbucket project.

## Layout

| Path                    | What it is                                                     |
| ----------------------- | -------------------------------------------------------------- |
| `packages/app`          | Frontend. New frontend system — `createApp`, blueprints        |
| `packages/backend`      | Backend. New backend system — `createBackend()`                |
| `plugins/fleet`         | Fleet dashboard, productivity page, entity cards               |
| `plugins/fleet-backend` | Bitbucket ingestion, scoring, ownership, search collator       |
| `plugins/fleet-common`  | Types, permissions and problem derivation shared by both sides |
| `catalog/`              | Ownership and identity registers, read through config          |

Metrics are **not** stored in the catalog. Bitbucket facts, rollups and scores
live in the fleet plugin's own database, keyed by entity ref; scores are
computed on a schedule and read back pre-computed.

## Running it

```sh
docker compose up -d   # Postgres on :5432, Adminer on :8080
yarn install
yarn start             # app :3000, backend :7007
```

Secrets go in `app-config.local.yaml`, which is gitignored. Committed config
uses `${ENV_VAR}` placeholders only.

## Checks

```sh
yarn tsc                # typecheck
yarn lint:all           # lint everything
CI=true yarn test       # unit tests
yarn test:e2e           # playwright
yarn workspace app build  # the only check that compiles index.html
```

`yarn tsc`, `yarn lint:all` and `yarn prettier:check` do **not** compile
`packages/app/public/index.html`. Anything touching that file or an imported
asset needs the app build.

Working notes, measured facts about the estate and the reasoning behind the
architecture are in [CLAUDE.md](./CLAUDE.md).
