/* eslint-disable func-names */

/**
 * Who took part in each pull request, and who merged it.
 *
 * Requirement 8 asks for pull requests **reviewed**, **approved** and **merged**
 * per engineer. All three are already in the pull request payload Bitbucket
 * returns -- the client simply reduced participants to `approval_count` and
 * `participant_count` and threw the people away, exactly as it once did with
 * commit parents.
 *
 * **This costs no extra API requests.** `values.participants.user.display_name`,
 * `values.participants.user.account_id` and `values.closed_by.*` are additional
 * fields on the same list request. Verified against the live API: the list
 * endpoint omits participants entirely by default and returns them in full when
 * the field selector asks, which is why they looked unavailable at first.
 *
 * Participants are keyed on `account_id`, not email: Bitbucket does not give an
 * address for a participant, and `GET /2.0/users/{account_id}` is 403 for this
 * token. Attribution therefore joins the display name to the identity register,
 * which measured 332 of 332 pull request authors matched on this estate. Any
 * participant that fails to match is reported rather than dropped.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('pull_request_participant', table => {
    table.increments('id').primary();
    table
      .integer('pull_request_id')
      .notNullable()
      .references('id')
      .inTable('pull_request')
      .onDelete('CASCADE');
    // Stable across renames, unlike the display name -- but the only thing that
    // can be joined to a person is the name, until Entra ID lands.
    table.string('account_id', 128).nullable();
    table.string('display_name', 255).nullable();
    /** PARTICIPANT or REVIEWER. A reviewer was asked; a participant turned up. */
    table.string('role', 32).notNullable();
    table.boolean('approved').notNullable().defaultTo(false);
    /**
     * When they last acted. Null when they were assigned and never responded,
     * which is a different thing from not being involved.
     */
    table.timestamp('participated_at', { useTz: true }).nullable();

    table.unique(['pull_request_id', 'account_id']);
    table.index(['account_id'], 'pr_participant_account_index');
    table.index(['approved'], 'pr_participant_approved_index');
  });

  await knex.schema.alterTable('pull_request', table => {
    // Who pressed merge. Not necessarily the author, and not necessarily an
    // approver: on this estate one person merged three consecutive pull
    // requests they had not written.
    table.string('closed_by_account_id', 128).nullable();
    table.string('closed_by_name', 255).nullable();
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('pull_request_participant');
  await knex.schema.alterTable('pull_request', table => {
    table.dropColumn('closed_by_account_id');
    table.dropColumn('closed_by_name');
  });
};
