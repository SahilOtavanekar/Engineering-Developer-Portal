import type { SchedulerServiceTaskScheduleDefinitionConfig } from '@backstage/backend-plugin-api';

export interface Config {
  fleet?: {
    bitbucket?: {
      /**
       * Bitbucket workspace slugs to ingest.
       *
       * Required, and cannot be defaulted: Atlassian removed the endpoints that
       * enumerated workspaces (CHANGE-2770), so the portal has no way to
       * discover them.
       */
      workspaces: string[];

      /**
       * How often repositories are re-read from Bitbucket.
       * Defaults to every 30 minutes.
       */
      schedule?: SchedulerServiceTaskScheduleDefinitionConfig;

      /**
       * How far back a first-time commit ingestion reaches, in days.
       * Subsequent passes are incremental. Defaults to 90.
       */
      commitWindowDays?: number;
    };

    /**
     * Derived and confirmed repository ownership.
     *
     * `candidates`, `minimumShare` and `minimumCommits` tune the commit-history
     * resolver's inference. `register` is not an inference at all -- it is the
     * confirmed answer, and takes precedence over every derived source.
     */
    ownership?: {
      /** How many ranked candidates to keep per repository. Defaults to 5. */
      candidates?: number;
      /**
       * Share of window commits a leader needs before being proposed.
       * Defaults to 0.5.
       */
      minimumShare?: number;
      /** Commits a leader needs before being proposed. Defaults to 3. */
      minimumCommits?: number;

      /**
       * Confirmed ownership, keyed by repository slug.
       *
       * Supplied by `$include` of a YAML file so it stays reviewable in git and
       * editable by people who do not build the portal. Absent means the portal
       * has no confirmed ownership and every owner it shows is a derived guess.
       */
      register?: {
        /**
         * Identities the register's short owner names refer to. A name absent
         * here produces no candidate rather than a guess.
         */
        people?: {
          [key: string]: {
            name: string;
            email: string;
          };
        };
        /** Repository slug to owner names, strongest first. */
        repositories?: {
          [slug: string]: string[];
        };
      };
    };

    /**
     * Who the commit authors are.
     *
     * An address is not a person. Without this, per-engineer figures split
     * anyone who commits under more than one address into several engineers.
     */
    identity?: {
      register?: {
        /**
         * Keyed by a stable slug. `aliases` are additional addresses the same
         * human commits under; they resolve to `email`.
         */
        people?: {
          [key: string]: {
            name: string;
            /**
             * Canonical address, when they have one. **Optional**, because
             * reviewing is not committing: a person can appear in the estate
             * without ever having committed, and there is then no address to
             * key them on -- `/2.0/users/{account_id}` is 403 for this token,
             * so a pull request supplies a display name and nothing more.
             * Requiring it would silently erase a real contributor, and
             * inventing one would later attribute somebody else's commits to
             * them. Mirrors `RegisteredEngineer.email`.
             */
            email?: string;
            aliases?: string[];
          };
        };
        /** Addresses belonging to no person -- bots, agents. Counted nowhere. */
        notPeople?: string[];
      };
    };

    /**
     * How much work is stranded on unmerged branches.
     *
     * The only pass that costs a request per *branch* rather than per
     * repository, so both knobs are about spending: how often it runs, and how
     * many requests one sweep may spend before leaving the rest for next time.
     */
    branchDivergence?: {
      /** Defaults to 360 (six hours). Divergence barely moves. */
      frequencyMinutes?: number;
      /** Defaults to 400. The estate needs about 185 today. */
      requestBudget?: number;
    };

    /** Health scoring. Weights and thresholds are config, never code. */
    scoring?: {
      /** Activity window scorers measure over, in days. Defaults to 90. */
      windowDays?: number;

      /**
       * Window for the pull-request discipline metric, in days. Defaults to 30.
       *
       * Deliberately shorter than `windowDays`. Direct commits to default
       * branches fell from 7.8 a day to 0.38 a day around 2026-07-27, so a
       * 90-day count mostly reports behaviour that has already changed.
       */
      disciplineWindowDays?: number;

      /**
       * Score bands, as specified by the product owner: Excellent 90-100,
       * Healthy 75-89, Needs Attention 60-74, At Risk below 60.
       *
       * Still config rather than code -- they decide which teams are told
       * their repository is failing -- but the defaults are the specification
       * now, not the placeholders that stood here before.
       */
      bands?: {
        /** At or above this total, Excellent. Defaults to 90. */
        excellent?: number;
        /** At or above this total, Healthy. Defaults to 75. */
        healthy?: number;
        /** At or above this total, Needs Attention. Below it, At Risk. Defaults to 60. */
        needsAttention?: number;
      };

      /**
       * The seven metrics the specification defines, and nothing else.
       *
       * Weights default to the figures in its tables and total exactly 100:
       * 20 / 15 / 20 / 15 / 10 / 10 / 10. A test pins that sum, because a
       * silent drift rescales every score on the estate.
       */
      metrics?: {
        /**
         * Whether the default branch reflects recent work, banded on the age
         * of its newest commit: within 30 days earns the full 20, 31-60 days
         * earns 7, 61-90 days earns 3, older earns nothing.
         */
        mainBranchCurrent?: { weight?: number };
        /**
         * Whether anybody is working on the repository **anywhere in it** --
         * the newest commit on any branch, not just the default one. Banded on
         * the same 30/60/90 day boundaries but with a gentler 10/7/3 shape, so
         * a slowdown costs far less than main going quiet.
         *
         * Deliberately a different measurement from `mainBranchCurrent`: 7
         * repositories have a stale main branch with live work on a branch, and
         * reading one timestamp for both rules would hide every one of them.
         */
        activeDevelopment?: { weight?: number };
        /**
         * Mean changed lines per merged pull request, banded under 400 /
         * 400-1,000 / over 1,000 for 10 / 3 / **1** points -- the only metric
         * whose bottom band is not zero.
         *
         * Measured through `/pullrequests/{id}/diffstat`, one request per pull
         * request: the list endpoint carries no diffstat under any spelling, so
         * unlike `merge_commit.hash` this cannot ride an existing call. That is
         * why it has its own slow pass and a request budget.
         */
        pullRequestSize?: {
          weight?: number;
          /**
           * Which statistic the bands are applied to. Defaults to `mean`, the
           * specification's "Average PR Size".
           *
           * **Measured 2026-09-10, and the case for `median` is strong.**
           * Across the 44 repositories with merged pull requests: mean scores
           * 13 at full marks and **25 at 1 of 10**; median scores 24 and 13.
           * The difference is release mechanics, not review burden --
           * `oxp-backend` merged 66 pull requests typically 240 lines long and
           * scores 1 of 10 because one promotion moved 35,028 lines.
           *
           * Config rather than a code change because it deviates from the
           * document: switching is a product decision somebody with authority
           * should be able to make and reverse without a deploy.
           */
          statistic?: 'mean' | 'median';
          /**
           * Requests one sweep may spend. Defaults to 400, which clears this
           * estate's ~389 unmeasured pull requests in a single pass.
           *
           * Larger than needed on purpose: a half-measured metric scores a
           * repository on whichever of its pull requests happened to be
           * reached first, which is worse than not scoring it.
           */
          requestBudget?: number;
          /**
           * How often the sweep runs, in minutes. Defaults to 360.
           *
           * A merged pull request is immutable, so a measured row is never
           * refetched and steady-state cost is only what has merged since --
           * a handful. Running it on the common half-hour cadence would spend
           * a budget to learn nothing.
           */
          frequencyMinutes?: number;
          /**
           * Paths whose changed lines are not counted, replacing the built-in
           * list entirely.
           *
           * A trailing slash matches a directory segment at any depth
           * (`dist/`); anything else is an exact file name (`yarn.lock`). Not
           * globs -- a real glob engine would be a dependency and a
           * configuration surface for a list of seventeen literals.
           *
           * The requirement suggests excluding generated and vendored files,
           * and on this estate it is worth real points: one
           * `package-lock.json` was 6,813 of `dai-delivery#1`'s 31,856 changed
           * lines. Deliberately conservative -- over-excluding flatters a
           * repository, which is the worse failure for a metric meant to find
           * risk.
           */
          generatedPaths?: string[];
        };
        /**
         * Not registered. Dropped from the scorecard on 2026-09-09 -- the
         * specification's seven rules do not include either -- so these keys
         * are inert. The scorers are kept and tested; reinstating one is a
         * line in `plugin.ts`, at which point the weights must be rebalanced
         * to keep the sum at 100.
         */
        activeContributors?: { weight?: number; target?: number };
        /** Not registered; see `activeContributors`. */
        pipelinePassing?: { weight?: number };
        /**
         * Branches with no commit inside the window that ought to be deleted,
         * banded on the **count**: none earns full marks, 1-2 earns 7 of 15,
         * 3-5 earns 4, more than 5 earns nothing.
         *
         * Excludes the default branch, whose staleness is `mainBranchCurrent`'s
         * job -- and suggesting somebody delete the branch the repository is
         * built on would discredit the whole scorecard.
         */
        staleBranches?: {
          weight?: number;
          /**
           * Branch names that are stale by design and must not be counted.
           *
           * The specification's "removed **or explicitly exempted**". Needed
           * because a real part of this estate's stale count is a deliberate
           * release process: `stage` is long-lived on 12 repositories carrying
           * 355 commits, `staging` on 2, `dev` on 6 and `dev-stage` on 1 --
           * roughly 750 of 2,699 stranded commits that will never merge to
           * main and that nobody should delete.
           *
           * Exact names, matched case-insensitively. Defaults to those four.
           * `master` is deliberately **not** among them: a `master` left
           * behind by a rename to `main` is exactly the branch this rule
           * exists to catch.
           *
           * Applies to the score and to the branches the repository card names,
           * so the two cannot disagree.
           */
          exempt?: string[];
        };
        /**
         * Share of merged pull requests that were reviewed, banded: 90% or
         * better earns the full 15, 70-89% earns 7, below that nothing.
         */
        codeReviewCompleted?: {
          weight?: number;
          /**
           * Whether an approval by the pull request's own author counts as a
           * review. Defaults to **false**, which is the specification's
           * recommended baseline ("Author cannot approve own PR").
           *
           * Measured 2026-09-09 over the 365 pull requests merged in 90 days:
           * 265 carried an approval and only **85** carried one from anybody
           * other than the author. Setting this true takes 20 repositories
           * from zero back to full marks, so it is deliberately reversible
           * without a deploy.
           */
          countSelfApprovals?: boolean;
        };
        readmeAvailable?: { weight?: number };
        /**
         * Share of commits on the default branch that arrived through a pull
         * request, banded: only 100% earns the full 20, 95-99% earns 7,
         * 80-94% earns 3, below that nothing.
         *
         * The two middle bands are unreachable below 20 mainline commits in
         * the window, so on this estate the metric pays 20 or 0.
         */
        pullRequestDiscipline?: { weight?: number };
        /**
         * Not registered; see `activeContributors`. The ownership register
         * itself is untouched -- `spec.owner`, the catalog's Owner column and
         * filter, the `confirmed-owner` tag and the About card all still work.
         * Only the points stopped.
         */
        ownerAssigned?: { weight?: number };
      };
    };
  };
}
