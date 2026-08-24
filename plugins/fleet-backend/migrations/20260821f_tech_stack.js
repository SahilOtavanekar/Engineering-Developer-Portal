// @ts-check

/**
 * Technology stack derived from repository manifests.
 *
 * `derived_language` sits beside Bitbucket's own `language` rather than
 * replacing it: one is reported at source, the other inferred from a manifest.
 * Bitbucket reports no language for 94% of this estate, so the inferred value
 * is what the catalog will usually show -- but keeping them apart means it is
 * always clear which a given value came from.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('repository', table => {
    table.text('tech_stack').nullable();
    table.string('derived_language', 64).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('repository', table => {
    table.dropColumn('derived_language');
    table.dropColumn('tech_stack');
  });
};
