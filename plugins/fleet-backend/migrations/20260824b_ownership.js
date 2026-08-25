// @ts-check

/**
 * Candidate owners derived from commit history.
 *
 * These are **proposals, not ownership**. Confirmed ownership lives in the
 * catalog, on `spec.owner`, and every repository is still on the placeholder
 * `group:default/unowned` there. Writing a derived guess into the catalog would
 * make it read as authoritative everywhere in Backstage and would silently
 * outrank the real project-to-team mapping when that arrives.
 *
 * Several candidates are kept, ranked, because confirming an owner is much
 * easier when the runners-up are visible: "Ada 34, Alan 5" is a decision, "Ada"
 * is a claim to be taken on trust.
 *
 * A snapshot, replaced wholesale on each pass -- there is no history here worth
 * keeping, unlike scores.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('ownership_candidate', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    // 1 is the strongest candidate.
    table.integer('rank').notNullable();

    // Whether the resolver was confident enough to actually put this name
    // forward. Recorded rather than re-derived by readers: the thresholds are
    // configurable, so anything re-deriving the decision would silently
    // disagree with the pass that made it the moment they were tuned.
    table.boolean('is_proposed').notNullable().defaultTo(false);

    table.string('author_name', 255).nullable();
    table.string('author_email', 320).nullable();
    table.string('author_account_id', 128).nullable();

    // The evidence. Share is this author's commits over the window total, so a
    // reader can tell a clear owner from a marginal plurality.
    table.integer('commits').notNullable();
    table.integer('window_commits').notNullable();

    table.integer('window_days').notNullable();

    // Which resolver produced this. Commit history today, Microsoft Entra
    // later; a reader has to be able to tell a guess from a system of record.
    table.string('source', 64).notNullable();
    table.dateTime('resolved_at').notNullable();

    table.unique(['repository_id', 'rank']);
    table.index('repository_id');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('ownership_candidate');
};
