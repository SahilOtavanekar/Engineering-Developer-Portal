// @ts-check

/**
 * Timestamps that make section 6's two pull request durations honest.
 *
 * `closed_at` is when the pull request was actually merged or declined.
 * "Average merge duration" was previously derived from `updated_at - created_at`,
 * which moves on any later edit: pull request 98 on `oxp-backend` was merged 38
 * seconds after opening but last updated four minutes after, overstating its
 * merge duration roughly sevenfold.
 *
 * `first_approval_at` is when the first reviewer approved, which is what
 * section 6's "PR review time" asks for and is a different measurement from
 * merge duration -- the wait to be unblocked, rather than the wait to land.
 *
 * Both nullable. Rows ingested before this migration have neither, and the
 * summary falls back to the old approximation for those rather than dropping
 * them; a re-ingestion fills them in.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('pull_request', table => {
    table.dateTime('closed_at').nullable();
    table.dateTime('first_approval_at').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('pull_request', table => {
    table.dropColumn('closed_at');
    table.dropColumn('first_approval_at');
  });
};
