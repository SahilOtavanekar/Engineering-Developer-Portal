// @ts-check

/**
 * Repository facts.
 *
 * Deliberately mirrors metadata the catalog also holds. The catalog owns
 * identity, ownership and relationships; this table is a derived cache with a
 * single writer, and it exists so scoring and fleet queries -- "Critical repos
 * in project DDS, largest first" -- resolve in one indexed scan rather than a
 * cross-store join on every page render.
 *
 * Child fact tables (branches, commits, pull requests, pipelines) reference
 * `id` rather than the entity ref, to keep those rows narrow at volume.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('repository', table => {
    table.increments('id').primary();

    // Join key to the Backstage catalog, e.g. 'component:default/oxp-backend'.
    table.string('entity_ref', 512).notNullable().unique();

    // Bitbucket's own identity for the repository.
    table.string('workspace', 255).notNullable();
    table.string('slug', 255).notNullable();

    table.string('name', 512).notNullable();
    table.text('description').nullable();
    table.string('url', 1024).notNullable();
    table.string('project_key', 128).nullable();
    table.string('default_branch', 255).nullable();
    table.boolean('is_private').notNullable().defaultTo(true);
    table.string('language', 128).nullable();
    table.bigInteger('size_bytes').nullable();

    // Timestamps reported by Bitbucket.
    table.dateTime('created_at').nullable();
    table.dateTime('updated_at').nullable();

    // Timestamps owned by the portal. The catalog has no concept of these.
    table.dateTime('first_seen_at').notNullable();
    table.dateTime('last_synced_at').notNullable();

    // Repositories are never hard-deleted: history that references them must
    // stay valid, and "when did this disappear" is itself a fact worth keeping.
    table.boolean('is_live').notNullable().defaultTo(true);
    table.dateTime('removed_at').nullable();

    table.unique(['workspace', 'slug']);
    table.index(['workspace', 'is_live']);
    table.index('project_key');
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTable('repository');
};
