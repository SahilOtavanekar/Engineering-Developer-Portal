/**
 * One-off backfill for `commit.parents`, added by 20260826_branch_policy.
 *
 * Commits ingested before that column existed have no parent hashes, and the
 * incremental watermark (`since = known ?? windowStart`) means ingestion never
 * revisits them -- so without this the branch policy pass skips every
 * repository for ever.
 *
 * **Fills in place rather than deleting and re-ingesting.** `DELETE FROM commit`
 * followed by a re-ingest reaches the same end state, but leaves a window where
 * the estate has no commits; a scoring pass firing inside it would write a row
 * of near-zero scores, and score history is append-only and cannot be
 * corrected. This only ever writes a column that was null.
 *
 * Read-only against Bitbucket. Safe to re-run: it skips repositories that are
 * already complete.
 *
 *   node plugins/fleet-backend/scripts/backfill-commit-parents.js
 *
 * Requires the app-config credentials and a reachable database.
 */
const fs = require('fs');
const yaml = require('yaml');
const knexFactory = require('knex');

const config = yaml.parse(fs.readFileSync('app-config.yaml', 'utf8'));
const local = yaml.parse(fs.readFileSync('app-config.local.yaml', 'utf8'));

const pg = {
  ...config.backend?.database?.connection,
  ...local.backend?.database?.connection,
};
const entry = local.integrations.bitbucketCloud[0];
const AUTH = `Basic ${Buffer.from(
  `${entry.username}:${entry.appPassword}`,
).toString('base64')}`;
const WORKSPACES = config.fleet?.bitbucket?.workspaces ?? [];

let requests = 0;
async function get(url) {
  requests++;
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: AUTH, Accept: 'application/json' },
    });
    if (res.ok) return res.json();
    if (res.status === 429) {
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    return { __status: res.status };
  }
  return { __status: 429 };
}

(async () => {
  const db = knexFactory({
    client: 'pg',
    connection: { ...pg, database: 'backstage_plugin_fleet' },
  });

  try {
    const repos = await db('repository')
      .where({ is_live: true })
      .whereIn('workspace', WORKSPACES)
      .whereNotNull('default_branch')
      .select('id', 'workspace', 'slug', 'default_branch')
      .orderBy('slug');

    let filled = 0;
    let skipped = 0;

    for (const repo of repos) {
      const [{ n }] = await db('commit')
        .where({ repository_id: repo.id })
        .whereNull('parents')
        .where('parent_count', '>', 0)
        .count({ n: '*' });
      if (Number(n) === 0) {
        skipped++;
        continue;
      }

      const fields = 'next,values.hash,values.parents.hash';
      let url =
        `https://api.bitbucket.org/2.0/repositories/${repo.workspace}/${repo.slug}/` +
        `commits/${encodeURIComponent(
          repo.default_branch,
        )}?pagelen=100&fields=${fields}`;

      const updates = [];
      for (let page = 0; url && page < 50; page++) {
        const body = await get(url);
        if (body.__status) {
          process.stdout.write(
            `  ${repo.slug}: HTTP ${body.__status}, skipping\n`,
          );
          break;
        }
        for (const commit of body.values ?? []) {
          const parents = (commit.parents ?? [])
            .map(p => p?.hash)
            .filter(h => typeof h === 'string');
          if (parents.length)
            updates.push({ hash: commit.hash, parents: parents.join(',') });
        }
        url = body.next;
      }

      let wrote = 0;
      for (const update of updates) {
        wrote += await db('commit')
          .where({ repository_id: repo.id, hash: update.hash })
          .whereNull('parents')
          .update({ parents: update.parents });
      }
      filled += wrote;
      process.stdout.write(
        `  ${repo.slug.padEnd(36)} ${String(wrote).padStart(
          4,
        )} filled (${Number(n)} were missing)\n`,
      );
    }

    const [{ still }] = await db('commit')
      .whereNull('parents')
      .where('parent_count', '>', 0)
      .count({ still: '*' });

    console.log('');
    console.log(`repositories visited : ${repos.length - skipped}`);
    console.log(`already complete     : ${skipped}`);
    console.log(`commits filled       : ${filled}`);
    console.log(`still missing parents: ${Number(still)}`);
    console.log(`requests used        : ${requests}`);
  } finally {
    await db.destroy();
  }
})();
