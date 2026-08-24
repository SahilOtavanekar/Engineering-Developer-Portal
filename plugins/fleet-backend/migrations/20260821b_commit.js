// @ts-check

/**
 * Commit facts, plus the denormalised `last_commit_at` they feed.
 *
 * `last_commit_at` lives on `repository` rather than being computed with
 * MAX(committed_at) on read: it backs the "Last Commit Date" field in section 3
 * and the staleness signals in section 6, both of which are rendered per row in
 * fleet-wide listings. An aggregate per row per render is exactly what the
 * two-second budget cannot afford.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('commit', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    table.string('hash', 64).notNullable();
    table.dateTime('committed_at').notNullable();
    table.text('message').nullable();

    // Most commits identify their author only by the git author string. Mapping
    // those to real people is a separate problem, deliberately not solved here.
    table.string('author_raw', 512).nullable();
    table.string('author_name', 255).nullable();
    table.string('author_email', 320).nullable();
    table.string('author_account_id', 128).nullable();

    // 2 or more means a merge. Counting merges as authored work inflates every
    // activity metric, so the distinction is preserved at ingestion time.
    table.integer('parent_count').notNullable().defaultTo(1);

    table.unique(['repository_id', 'hash']);
    table.index(['repository_id', 'committed_at']);
    table.index('author_email');
    table.index('committed_at');
  });

  await knex.schema.alterTable('repository', table => {
    table.dateTime('last_commit_at').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('repository', table => {
    table.dropColumn('last_commit_at');
  });
  await knex.schema.dropTable('commit');
};
