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

    /** Health scoring. Weights and thresholds are config, never code. */
    scoring?: {
      /** Activity window scorers measure over, in days. Defaults to 90. */
      windowDays?: number;

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
        codeReviewCompleted?: { weight?: number };
        readmeAvailable?: { weight?: number };
        /** No data source yet; weight is reported as forfeited. */
        ownerAssigned?: { weight?: number };
        /** No data source yet; weight is reported as forfeited. */
        securityScanPassing?: { weight?: number };
      };
    };
  };
}
