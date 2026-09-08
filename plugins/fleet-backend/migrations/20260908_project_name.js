/* eslint-disable func-names */

/**
 * The Bitbucket project's human name, beside the key already stored.
 *
 * **Costs no API requests.** `project.name` rides in the same partial-response
 * projection that lists every repository in the workspace -- one request for
 * all 98 -- so this is the `merge_commit.hash` and PR-participants lesson
 * again: the field was always there, nothing had asked the selector for it.
 *
 * **It is often just the key repeated, and callers must expect that.** Probed
 * against the live workspace on 2026-09-08: AM is `Amplifye`, DDS is
 * `DAI Delivery Systems`, RES is `Research`, but DAARWYN and MDLH are their own
 * keys and DAIWEB is `DAI-WEB`. Half the estate gains nothing, including MDLH,
 * which is the largest project at 37 repositories.
 *
 * Nullable and backfilled by the next ingestion pass rather than by a script:
 * unlike `commit.parents`, repository rows are re-upserted wholesale every 30
 * minutes from a fresh listing, so there is no watermark to strand old rows
 * behind. Until that pass runs, `project_name` is null and the System's
 * description falls back to the wording it had.
 */
exports.up = async function (knex) {
  await knex.schema.alterTable('repository', table => {
    table.text('project_name').nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('repository', table => {
    table.dropColumn('project_name');
  });
};
