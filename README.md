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
| `plugins/fleet`         | Health dashboard, productivity page, entity cards              |
| `plugins/fleet-backend` | Bitbucket ingestion, scoring, ownership, search collator       |
| `plugins/fleet-common`  | Types, permissions and problem derivation shared by both sides |
| `catalog/`              | Ownership and identity registers, read through config          |
| `examples/`             | `org.yaml` only. **Not** example data — see below              |

Despite its name, `examples/` is production data: `org.yaml` carries the User
entity the GitHub sign-in resolver matches a login against, and the `unowned`
group every repository without a confirmed owner is counted against. Deleting
it breaks sign-in.

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
carries `${ENV_VAR}` placeholders and never a real value.

**A fresh clone will not ingest anything until you add a Bitbucket credential.**
`integrations.bitbucketCloud` is the portal's most load-bearing config — the
fleet plugin reads it through `ScmIntegrations.fromConfig` and refuses to run
its passes without it — and it is in no committed file, because it carries a
credential:

```yaml
# app-config.local.yaml
integrations:
  bitbucketCloud:
    - username: <bitbucket username>
      appPassword: <app password>
    # or, instead of the pair above:
    # - token: <repository / project / workspace access token>
```

It is deliberately not a `${...}` placeholder in `app-config.yaml`: an unset
env var makes Backstage drop the key, which turns a clear "no
integrations.bitbucketCloud entry" error into a schema failure on a half-built
list entry.

## Checks

```sh
yarn tsc                # typecheck
yarn lint:all           # lint everything
yarn prettier:check     # formatting — CI runs this
CI=true yarn test       # unit tests
yarn test:e2e           # playwright, against a running app
yarn workspace app build  # the only check that compiles index.html
```

Two gaps worth knowing, because CI passes without covering either:

**No check loads a real `app-config`.** Nothing in the unit suite reads one, so
a config schema that contradicts a register — or a `catalog.locations` entry
pointing at a deleted file — passes everything. This is the check that catches
it, and it is worth running after any `config.d.ts` or register change:

```sh
yarn backstage-cli config:check --config app-config.yaml \
  --config app-config.local.yaml --strict
```

**`yarn tsc` does not typecheck `packages/app/e2e-tests`.** The `include` globs
in `tsconfig.json` cover `packages/*/src` only, so those files are linted but
never type-checked.

`yarn tsc`, `yarn lint:all` and `yarn prettier:check` also do **not** compile
`packages/app/public/index.html`. Anything touching that file or an imported
asset needs the app build.

Working notes, measured facts about the estate and the reasoning behind the
architecture are in [CLAUDE.md](./CLAUDE.md).
