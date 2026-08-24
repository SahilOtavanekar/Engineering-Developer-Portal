// @ts-check

/**
 * Branch and pipeline facts.
 *
 * Both are snapshots rather than history: unlike commits, a branch's state and
 * a pipeline's result are re-read wholesale each pass, so these tables are
 * replaced per repository rather than appended to.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('branch', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    table.string('name', 512).notNullable();
    table.dateTime('last_commit_at').nullable();
    table.string('last_commit_hash', 64).nullable();
    table.boolean('is_default').notNullable().defaultTo(false);

    table.unique(['repository_id', 'name']);
    table.index(['repository_id', 'last_commit_at']);
  });

  await knex.schema.createTable('pipeline_run', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    table.string('uuid', 128).notNullable();
    table.integer('build_number').nullable();

    // COMPLETED / IN_PROGRESS / PENDING, and for completed runs the result:
    // SUCCESSFUL / FAILED / STOPPED / ERROR. Kept separate because an
    // in-progress run has no result and must not be counted as a failure.
    table.string('state', 32).notNullable();
    table.string('result', 32).nullable();

    table.string('ref_name', 512).nullable();
    table.dateTime('created_at').notNullable();
    table.integer('duration_seconds').nullable();

    table.unique(['repository_id', 'uuid']);
    table.index(['repository_id', 'created_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('pipeline_run');
  await knex.schema.dropTable('branch');
};
