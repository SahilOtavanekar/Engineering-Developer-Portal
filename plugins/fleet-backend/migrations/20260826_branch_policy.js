/* eslint-disable func-names */

/**
 * Records how each commit reached the default branch, so the portal can both
 * score pull-request discipline and offer a filter for the repositories failing
 * it.
 *
 * `parents` is the missing piece: the client already asks Bitbucket for
 * `values.parents.hash` and throws the hashes away, keeping only the count. The
 * first-parent chain is what separates a commit made on the branch from one a
 * merge brought in from a feature branch -- measured on this estate, 1,168 of
 * 1,753 commits on default branches in 90 days arrived via a merge and must not
 * be counted as direct.
 *
 * `merge_commit_hash` on the pull request is the other half. **Bitbucket
 * returns it abbreviated to 12 characters** while commit hashes are full
 * 40-character SHAs, so the join has to be on a prefix. Matching them whole
 * classifies every commit as direct -- a plausible-looking result rather than an
 * obvious failure, and it cost a probe run to notice.
 *
 * `arrival` is stored per commit rather than aggregated per repository so any
 * reporting window is a query. That matters: direct commits to main fell from
 * 7.8 a day to 0.38 a day around 2026-07-27, so a 90-day count and a 30-day
 * count describe different worlds.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('commit', table => {
    // Comma-separated parent hashes, first parent first. Text rather than a
    // child table: it is only ever read whole, for one repository at a time.
    table.text('parents').nullable();
    // Null means not classified yet, which stays distinguishable from a commit
    // classified as off-mainline.
    table.boolean('on_mainline').nullable();
    table.string('arrival', 32).nullable();
    table.index(
      ['repository_id', 'arrival'],
      'commit_repository_arrival_index',
    );
  });

  await knex.schema.alterTable('pull_request', table => {
    table.string('merge_commit_hash', 64).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('commit', table => {
    table.dropIndex(
      ['repository_id', 'arrival'],
      'commit_repository_arrival_index',
    );
    table.dropColumn('parents');
    table.dropColumn('on_mainline');
    table.dropColumn('arrival');
  });
  await knex.schema.alterTable('pull_request', table => {
    table.dropColumn('merge_commit_hash');
  });
};
