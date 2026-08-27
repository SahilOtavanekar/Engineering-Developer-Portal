/**
 * One-off backfill for `pull_request.merge_commit_hash`, added by
 * 20260826_branch_policy.
 *
 * Pull requests ingested before that column existed have no merge hash, and
 * `PullRequestIngestionService` works from an `updated_on` watermark -- so a
 * pull request that has not been touched since is never re-fetched and never
 * acquires one. The consequence is not a gap but a wrong answer: the classifier
 * matching against an empty hash list reports every commit as direct. On this
 * estate the first pass produced 1,031 direct commits and zero via pull request.
 *
 * Read-only against Bitbucket, and only ever writes a column that was null.
 *
 *   node plugins/fleet-backend/scripts/backfill-pr-merge-hashes.js
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
      .select('id', 'workspace', 'slug')
      .orderBy('slug');

    let filled = 0;
    for (const repo of repos) {
      const [{ n }] = await db('pull_request')
        .where({ repository_id: repo.id, state: 'MERGED' })
        .whereNull('merge_commit_hash')
        .count({ n: '*' });
      if (Number(n) === 0) continue;

      const fields = 'next,values.id,values.merge_commit.hash';
      let url =
        `https://api.bitbucket.org/2.0/repositories/${repo.workspace}/${repo.slug}/` +
        `pullrequests?state=MERGED&pagelen=50&sort=-updated_on&fields=${fields}`;

      let wrote = 0;
      for (let page = 0; url && page < 20; page++) {
        const body = await get(url);
        if (body.__status) {
          process.stdout.write(`  ${repo.slug}: HTTP ${body.__status}\n`);
          break;
        }
        for (const pr of body.values ?? []) {
          if (!pr.merge_commit?.hash) continue;
          wrote += await db('pull_request')
            .where({ repository_id: repo.id, pr_id: pr.id })
            .whereNull('merge_commit_hash')
            .update({ merge_commit_hash: pr.merge_commit.hash });
        }
        url = body.next;
      }
      filled += wrote;
      process.stdout.write(
        `  ${repo.slug.padEnd(36)} ${String(wrote).padStart(
          4,
        )} filled (${Number(n)} were missing)\n`,
      );
    }

    const [{ still }] = await db('pull_request')
      .where({ state: 'MERGED' })
      .whereNull('merge_commit_hash')
      .count({ still: '*' });

    console.log('');
    console.log(`merge hashes filled  : ${filled}`);
    console.log(`still missing        : ${Number(still)}`);
    console.log(`requests used        : ${requests}`);
  } finally {
    await db.destroy();
  }
})();
