/* eslint-disable func-names */

/**
 * How far each branch has diverged from the default branch.
 *
 * The one thing the portal could not answer about branches: how much work is
 * sitting on them unmerged. `branchHygiene` measures whether a branch was
 * *touched* recently, which says nothing about how much is stranded on it.
 *
 * **Bitbucket carries no ahead/behind count.** Verified against the live API:
 * a branch object has only `name`, `target`, `links`, `type` and the merge
 * strategies -- no divergence at all. The only source is
 * `GET /commits/{branch}?exclude={default}`, which lists the commits reachable
 * from the branch but not from the default branch.
 *
 * **That list overstates divergence for squash-merged branches**, and 51% of
 * this estate's merged pull requests are squashed. A squash rewrites the
 * branch's commits into one new commit on main, so the originals stay
 * unreachable from main for ever and the branch reads as fully diverged when
 * its work has actually shipped. Two of eight branches sampled on
 * `oxp-frontend` were exactly this. The pass therefore skips any branch that is
 * the source of a merged pull request -- 77 of the estate's 262 non-default
 * branches -- using `pull_request.source_branch`, which is already stored and
 * costs nothing.
 *
 * **`is_capped` exists because the response carries no total.** The commits
 * endpoint returns no `size` field, so an exact count would mean paging through
 * every diverged commit. One page of 100 plus the presence of `next` gives
 * either an exact figure or "at least 100", which is all a health signal needs
 * -- anything past a couple of dozen is the same verdict.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('branch', table => {
    table
      .integer('diverged_commits')
      .nullable()
      .comment('Commits on this branch not reachable from the default branch');
    table
      .boolean('is_capped')
      .notNullable()
      .defaultTo(false)
      .comment('The real figure is at least diverged_commits, not exactly it');
    table
      .timestamp('diverged_checked_at', { useTz: true })
      .nullable()
      .comment('Null means never measured, which is not the same as zero');
  });
};

exports.down = async function down(knex) {
  await knex.schema.alterTable('branch', table => {
    table.dropColumn('diverged_commits');
    table.dropColumn('is_capped');
    table.dropColumn('diverged_checked_at');
  });
};
