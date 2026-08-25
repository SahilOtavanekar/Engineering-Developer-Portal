// @ts-check

/**
 * Derived component type and lifecycle.
 *
 * Both were hardcoded placeholders on the synthesized catalog entities --
 * `service` and `unknown` for all 95 repositories -- because when the entity
 * provider was written there was nothing to derive them from. Steps 13 and 17
 * supplied the evidence: a technology stack, and whether anything actually
 * reaches a Production environment.
 *
 * Stored rather than computed in the entity provider because the inputs live
 * in three tables the provider does not read. The detail ingestion pass already
 * holds all of them.
 *
 * Nullable, and read as "not classified yet" when null -- the provider falls
 * back to its placeholders rather than inventing a value.
 *
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('repository', table => {
    // service / website / unknown. Deliberately not `library`: nothing in the
    // estate distinguishes a library from an abandoned service, and half the
    // repositories have no CI at all -- calling those 48 libraries would be a
    // guess dressed as a fact.
    table.string('derived_type', 64).nullable();

    // production / experimental / unknown. Never `deprecated`: a quiet
    // repository is not a retired one, and only its team knows the difference.
    table.string('derived_lifecycle', 64).nullable();
  });
};

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.alterTable('repository', table => {
    table.dropColumn('derived_type');
    table.dropColumn('derived_lifecycle');
  });
};
