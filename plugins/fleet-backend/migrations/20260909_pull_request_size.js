/**
 * Pull request size, for the metric section 5 of the scorecard requires.
 *
 * **Nullable on purpose, and the distinction is load-bearing:** null means the
 * diffstat has never been fetched for this pull request, zero means it was
 * fetched and the pull request genuinely changed nothing. Verified against the
 * live API that the second really happens -- `oxp-backend#112` is merged and
 * has an empty diffstat -- so a `0` default would have made every unfetched row
 * indistinguishable from that one and silently handed out full marks.
 *
 * Bitbucket exposes changed lines only through
 * `/pullrequests/{id}/diffstat`, one request per pull request. Probed
 * 2026-09-09 across 48 pull requests: `pagelen=500` covers even a 158-file
 * diff in a single request, none of the 48 paginated, and the `fields`
 * selector is honoured so the response can be trimmed to what is stored.
 *
 * `files_added` is stored although nothing scores it yet. The probe found the
 * estate's largest pull requests are **initial imports** -- 157 of 158 files
 * `added` in `dai-delivery#1`, 31,856 changed lines -- and the added-file share
 * is the only field that separates those from real changes. It arrives in the
 * same response, and CLAUDE.md records what it costs to need a second backfill
 * for a column that was available the first time.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('pull_request', table => {
    /** Lines added, excluding generated and vendored paths. */
    table.integer('lines_added').nullable();
    /** Lines removed, excluding generated and vendored paths. */
    table.integer('lines_removed').nullable();
    /** Files touched, excluding generated and vendored paths. */
    table.integer('files_changed').nullable();
    /**
     * Of those, how many were newly added. A pull request that is almost
     * entirely additions is an import, not a change somebody could have made
     * smaller.
     */
    table.integer('files_added').nullable();
    /**
     * Lines excluded as generated or vendored, so the figure shown can be
     * reconciled against what Bitbucket displays. Measured at 21-25% of the
     * biggest diffs on this estate -- one `package-lock.json` was 6,813 lines.
     */
    table.integer('excluded_lines').nullable();
  });

  // The size pass claims work by finding merged pull requests with no diffstat
  // yet, oldest first. Partial indexes are Postgres-only and the unit suite
  // runs on SQLite, so this is a plain composite index -- it still serves the
  // `state = 'MERGED' and lines_added is null` scan.
  await knex.schema.alterTable('pull_request', table => {
    table.index(['state', 'lines_added'], 'pr_size_pending_index');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('pull_request', table => {
    table.dropIndex(['state', 'lines_added'], 'pr_size_pending_index');
  });
  await knex.schema.alterTable('pull_request', table => {
    table.dropColumn('excluded_lines');
    table.dropColumn('files_added');
    table.dropColumn('files_changed');
    table.dropColumn('lines_removed');
    table.dropColumn('lines_added');
  });
};
