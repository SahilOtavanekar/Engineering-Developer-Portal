// @ts-check

/**
 * Health scores, one row per repository per scoring run.
 *
 * Deliberately append-only rather than a single mutable row per repository.
 * The trend is what changes behaviour -- a score that moved from 40 to 70 says
 * something a bare 70 does not -- and history cannot be reconstructed after
 * the fact. This costs one row per repository per run, which at 95
 * repositories is nothing.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('repo_score', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    table.dateTime('computed_at').notNullable();

    // 0-100, computed over the metrics that could actually be measured.
    table.integer('total').notNullable();
    table.string('band', 32).notNullable();

    // How much of the nominal 100 was measurable this run. A score of 80 over
    // 30 available weight means something very different from 80 over 100, and
    // conflating them would let an incomplete portal flatter its own estate.
    table.integer('available_weight').notNullable();

    // Per-metric detail, so a score can always be explained rather than
    // asserted. A score nobody can interrogate gets dismissed as arbitrary.
    table.text('breakdown').notNullable();

    table.index(['repository_id', 'computed_at']);
    table.index('computed_at');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('repo_score');
};
