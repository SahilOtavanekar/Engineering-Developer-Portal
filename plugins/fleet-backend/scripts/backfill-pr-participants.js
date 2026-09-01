/**
 * One-off backfill for `pull_request_participant` and `pull_request.closed_by_*`,
 * added by 20260827_pr_participants.
 *
 * Both come from fields the pull request list endpoint returns once the field
 * selector asks for them, so ingestion picks them up from now on -- but
 * `PullRequestIngestionService` works from an `updated_on` watermark, so a pull
 * request nobody has touched since is never re-fetched and never acquires them.
 * Same shape of gap as commit parents and merge hashes before it.
 *
 * Read-only against Bitbucket. Safe to re-run: participants are replaced per
 * pull request, and `closed_by` is only written where it is null.
 *
 *   node plugins/fleet-backend/scripts/backfill-pr-participants.js
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

const FIELDS = [
  'next',
  'values.id',
  'values.participants.approved',
  'values.participants.role',
  'values.participants.participated_on',
  'values.participants.user.account_id',
  'values.participants.user.display_name',
  'values.closed_by.account_id',
  'values.closed_by.display_name',
].join(',');

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

    let participants = 0;
    let closers = 0;
    let visited = 0;

    for (const repo of repos) {
      const [{ n }] = await db('pull_request')
        .where({ repository_id: repo.id })
        .count({ n: '*' });
      if (Number(n) === 0) continue;
      visited++;

      let url =
        `https://api.bitbucket.org/2.0/repositories/${repo.workspace}/${repo.slug}/` +
        `pullrequests?state=MERGED&state=OPEN&state=DECLINED&pagelen=50&fields=${FIELDS}`;

      let wroteParts = 0;
      let wroteClosers = 0;
      for (let page = 0; url && page < 20; page++) {
        const body = await get(url);
        if (body.__status) {
          process.stdout.write(`  ${repo.slug}: HTTP ${body.__status}\n`);
          break;
        }
        for (const pr of body.values ?? []) {
          const row = await db('pull_request')
            .where({ repository_id: repo.id, pr_id: pr.id })
            .first('id');
          if (!row) continue;

          if (pr.closed_by?.display_name) {
            wroteClosers += await db('pull_request')
              .where({ id: row.id })
              .whereNull('closed_by_name')
              .update({
                closed_by_account_id: pr.closed_by.account_id ?? null,
                closed_by_name: pr.closed_by.display_name,
              });
          }

          if (!Array.isArray(pr.participants)) continue;
          await db('pull_request_participant')
            .where({ pull_request_id: row.id })
            .delete();
          const seen = new Set();
          const rows = [];
          for (const p of pr.participants) {
            const key = p.user?.account_id ?? `name:${p.user?.display_name}`;
            if (seen.has(key)) continue;
            seen.add(key);
            rows.push({
              pull_request_id: row.id,
              account_id: p.user?.account_id ?? null,
              display_name: p.user?.display_name ?? null,
              role: p.role ?? 'PARTICIPANT',
              approved: p.approved === true,
              participated_at: p.participated_on
                ? new Date(p.participated_on)
                : null,
            });
          }
          if (rows.length) {
            await db('pull_request_participant').insert(rows);
            wroteParts += rows.length;
          }
        }
        url = body.next;
      }

      if (wroteParts || wroteClosers) {
        process.stdout.write(
          `  ${repo.slug.padEnd(36)} ${String(wroteParts).padStart(
            4,
          )} participants, ` + `${String(wroteClosers).padStart(3)} closers\n`,
        );
      }
      participants += wroteParts;
      closers += wroteClosers;
    }

    const [{ total }] = await db('pull_request_participant').count({
      total: '*',
    });
    const [{ withCloser }] = await db('pull_request')
      .whereNotNull('closed_by_name')
      .count({ withCloser: '*' });

    console.log('');
    console.log(`repositories visited     : ${visited}`);
    console.log(`participant rows written : ${participants}`);
    console.log(`closers written          : ${closers}`);
    console.log(`participant rows total   : ${Number(total)}`);
    console.log(`pull requests with closer: ${Number(withCloser)}`);
    console.log(`requests used            : ${requests}`);
  } finally {
    await db.destroy();
  }
})();
