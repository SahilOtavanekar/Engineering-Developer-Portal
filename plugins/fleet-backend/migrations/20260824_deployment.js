// @ts-check

/**
 * Deployment records.
 *
 * Bitbucket only creates one when the `deployment:` value in a repository's
 * pipeline file exactly matches a configured environment name -- case included.
 * That is why 20 of the 47 repositories with pipelines have none: either they
 * declare no deployment step, or the name does not match. Both are conditions
 * in the repository, not gaps in this table.
 *
 * `environment_type` is Bitbucket's own three-way classification (Test /
 * Staging / Production) and is the stable thing to group by. `environment_name`
 * is free text and varies across the estate -- dev, Dev, Staging, Production.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('deployment', table => {
    table.increments('id').primary();
    table
      .integer('repository_id')
      .notNullable()
      .references('id')
      .inTable('repository')
      .onDelete('CASCADE');

    table.string('uuid', 128).notNullable();
    table.integer('number').nullable();

    table.string('environment_name', 255).notNullable();
    table.string('environment_type', 64).nullable();

    // COMPLETED / IN_PROGRESS / UNDEPLOYED.
    table.string('state', 32).notNullable();

    // What was actually shipped, so a deployment ties back to a commit.
    table.string('release_name', 255).nullable();
    table.string('commit_hash', 64).nullable();

    table.dateTime('created_at').notNullable();
    table.dateTime('last_updated_at').nullable();

    table.unique(['repository_id', 'uuid']);
    table.index(['repository_id', 'environment_name', 'created_at']);
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('deployment');
};
