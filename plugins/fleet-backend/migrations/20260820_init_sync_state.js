// @ts-check

/**
 * Tracks incremental synchronization progress for each external resource we
 * ingest. This table is what makes the reliability requirements -- retry failed
 * synchronization, incremental synchronization, idempotent processing --
 * implementable rather than aspirational.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('sync_state', table => {
    // Identifies the synced resource, e.g. 'repositories' for the estate-wide
    // sweep, or 'repo:acme/checkout:pull_requests' for one repo's PRs.
    table.string('resource', 255).primary().notNullable();

    // Opaque watermark telling the next run where to resume. Format is owned by
    // whichever syncer wrote it -- a timestamp, a page token, an ETag.
    table.string('cursor', 255).nullable();

    table.dateTime('last_attempt_at').nullable();
    table.dateTime('last_success_at').nullable();

    // Drives backoff. Reset to zero on success.
    table.integer('consecutive_failures').notNullable().defaultTo(0);
    table.text('last_error').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('sync_state');
};
