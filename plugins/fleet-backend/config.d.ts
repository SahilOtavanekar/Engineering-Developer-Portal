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
            email: string;
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
       * Score bands. Provisional until someone owns the numbers -- they decide
       * which teams are told their repository is failing.
       */
      bands?: {
        /** At or above this total, Healthy. Defaults to 70. */
        healthy?: number;
        /** At or above this total, Needs Attention. Below it, Critical. Defaults to 40. */
        needsAttention?: number;
      };

      metrics?: {
        activeCommits?: { weight?: number; target?: number };
        activeContributors?: { weight?: number; target?: number };
        pipelinePassing?: { weight?: number };
        branchHygiene?: { weight?: number };
        /**
         * Defaults to 10, not the document's 15. Approval is a weak signal on
         * this estate -- median time to first approval is 12 seconds -- so five
         * points moved to `pullRequestDiscipline`, which measures whether a
         * change went through a pull request at all.
         */
        codeReviewCompleted?: { weight?: number };
        readmeAvailable?: { weight?: number };
        /**
         * Share of commits on the default branch that arrived through a pull
         * request. Defaults to 10, funded by dropping the security-scan metric
         * and taking five points from `codeReviewCompleted`, so the eight
         * registered weights total exactly 100.
         */
        pullRequestDiscipline?: { weight?: number };
        /**
         * Earned only by an owner confirmed in `fleet.ownership.register`. A
         * derived owner scores zero: see `ownerAssignedScorer`.
         */
        ownerAssigned?: { weight?: number };
      };
    };
  };
}
