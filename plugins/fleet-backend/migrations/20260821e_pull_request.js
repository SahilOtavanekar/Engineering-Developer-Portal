// @ts-check

/**
 * Pull request facts, plus the repository-root file signals.
 *
 * Pull requests are appended rather than snapshotted: a merged PR is an
 * immutable historical fact, and keeping them lets review-time and
 * merge-duration trends be computed later without a second backfill.
 *
 * Bitbucket exposes no `merged_on` field. For a PR in state MERGED,
 * `updated_at` is effectively the merge time, which is what cycle-time
 * calculations use -- an approximation, and named honestly rather than
 * pretending to be exact.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('pull_request', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    // Bitbucket's own PR number, unique per repository.
    table.integer('pr_id').notNullable();
    table.string('title', 1024).nullable();
    table.string('state', 32).notNullable();

    table.dateTime('created_at').notNullable();
    table.dateTime('updated_at').notNullable();

    table.integer('comment_count').notNullable().defaultTo(0);
    // Reviewers who actually approved, as opposed to those merely assigned.
    table.integer('approval_count').notNullable().defaultTo(0);
    table.integer('participant_count').notNullable().defaultTo(0);

    table.string('author_account_id', 128).nullable();
    table.string('author_name', 255).nullable();
    table.string('source_branch', 512).nullable();
    table.string('destination_branch', 512).nullable();

    table.unique(['repository_id', 'pr_id']);
    table.index(['repository_id', 'state', 'updated_at']);
    table.index('updated_at');
  });

  await knex.schema.alterTable('repository', table => {
    table.boolean('has_readme').nullable();
    // Root paths as a JSON array. Held so manifest parsing can reuse the same
    // listing rather than paying for a second pass over the estate.
    table.text('root_files').nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('repository', table => {
    table.dropColumn('root_files');
    table.dropColumn('has_readme');
  });
  await knex.schema.dropTable('pull_request');
};
