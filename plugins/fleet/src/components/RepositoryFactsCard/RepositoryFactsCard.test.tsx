import type { Entity } from '@backstage/catalog-model';
import { fetchApiRef } from '@backstage/frontend-plugin-api';
import {
  renderInTestApp,
  TestApiProvider,
} from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import type { RepositoryFacts } from '@internal/backstage-plugin-fleet-common';
import { RepositoryFactsCard } from './RepositoryFactsCard';
import { OWNERSHIP_SOURCE_REGISTER } from '@internal/backstage-plugin-fleet-common';

const entity: Entity = {
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: { name: 'oxp-backend', namespace: 'default' },
  spec: {
    type: 'service',
    lifecycle: 'unknown',
    owner: 'group:default/unowned',
  },
};

const facts: RepositoryFacts = {
  entityRef: 'component:default/oxp-backend',
  workspace: 'demandai',
  slug: 'oxp-backend',
  url: 'https://bitbucket.org/demandai/oxp-backend',
  projectKey: 'DDS',
  defaultBranch: 'main',
  sizeBytes: 13_780_800,
  isPrivate: true,
  lastCommitAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
  lastSyncedAt: new Date(Date.now() - 3_600_000).toISOString(),
  activity: { windowDays: 90, commits: 261, authors: 5 },
  score: {
    total: 100,
    band: 'healthy',
    availableWeight: 30,
    nominalWeight: 30,
    computedAt: new Date().toISOString(),
    breakdown: [
      {
        id: 'active-commits',
        title: 'Active commits',
        weight: 20,
        points: 20,
        detail: '261 commits in 90 days',
        available: true,
      },
      {
        id: 'active-contributors',
        title: 'Active contributors',
        weight: 10,
        points: 10,
        detail: '5 contributors in 90 days',
        available: true,
      },
    ],
  },
};

/** Stubs the plugin:// fetch the card makes. */
function fetchApi(handler: () => Partial<Response>) {
  return { fetch: jest.fn(async () => handler() as Response) };
}

async function render(handler: () => Partial<Response>) {
  await renderInTestApp(
    <TestApiProvider apis={[[fetchApiRef, fetchApi(handler)]]}>
      <RepositoryFactsCard entity={entity} />
    </TestApiProvider>,
  );
}

const ok = (body: unknown) => () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('RepositoryFactsCard', () => {
  it('shows commit activity for a repository the portal knows', async () => {
    await render(ok(facts));

    expect(await screen.findByText('261')).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('3 days ago')).toBeInTheDocument();
  });

  it('shows the repository metadata', async () => {
    await render(ok(facts));

    expect(await screen.findByText('DDS')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.getByText('13 MB')).toBeInTheDocument();
    expect(screen.getByText('Private')).toBeInTheDocument();
  });

  it('links out to Bitbucket', async () => {
    await render(ok(facts));

    const link = await screen.findByRole('link', { name: /Open in Bitbucket/ });
    expect(link).toHaveAttribute(
      'href',
      'https://bitbucket.org/demandai/oxp-backend',
    );
  });

  it('says so plainly when the repository has never been committed to', async () => {
    await render(ok({ ...facts, lastCommitAt: undefined }));

    expect(await screen.findByText('Never')).toBeInTheDocument();
  });

  it('treats an unknown repository as information, not an error', async () => {
    await render(() => ({ ok: false, status: 404 }));

    expect(
      await screen.findByText(/No repository facts recorded yet/),
    ).toBeInTheDocument();
  });

  it('reports a genuine failure', async () => {
    await render(() => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    expect(
      await screen.findByText(/Could not load repository facts/),
    ).toBeInTheDocument();
  });

  it('shows the health score and its band', async () => {
    await render(ok(facts));

    expect(await screen.findByText('100')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
  });

  it('explains every metric that contributed to the score', async () => {
    // Points and detail are separate elements: they used to share one wrapped
    // line, which made the numbers the hardest thing on the card to find.
    await render(ok(facts));

    expect(await screen.findByText('20 / 20')).toBeInTheDocument();
    expect(screen.getByText('261 commits in 90 days')).toBeInTheDocument();
    expect(screen.getByText('10 / 10')).toBeInTheDocument();
    expect(screen.getByText('5 contributors in 90 days')).toBeInTheDocument();
  });

  it('flags a partial score rather than presenting it as complete', async () => {
    await render(
      ok({
        ...facts,
        score: { ...facts.score, availableWeight: 30, nominalWeight: 100 },
      }),
    );

    expect(
      await screen.findByText(/Scored over 30 of 100/),
    ).toBeInTheDocument();
    expect(screen.getByText('30 of 100 weight')).toBeInTheDocument();
  });

  /**
   * A short denominator has two unrelated causes and they need opposite things
   * said about them: a metric the **portal** cannot measure at all, and a
   * metric this **repository** has no data for. One sentence about both is
   * what made the old text wrong -- reporting the portal's own gap as "this
   * repository has nothing to measure" sends a team hunting data that exists
   * and that nothing has asked Bitbucket for.
   *
   * `pull-request-size` was the example of the first until the diffstat
   * ingestion landed; nothing is in that category today, which is why the
   * first case below asserts an absence.
   */
  describe('the two reasons a metric goes unmeasured', () => {
    const withUnmeasured = (
      entries: Array<{ id: string; title: string; weight: number }>,
    ) =>
      ok({
        ...facts,
        score: {
          ...facts.score,
          availableWeight: 100 - entries.reduce((a, e) => a + e.weight, 0),
          nominalWeight: 100,
          breakdown: entries.map(e => ({
            ...e,
            detail: 'Not measured yet',
            available: false,
          })),
        },
      });

    /**
     * **No metric is the portal's gap any more**, and that is the good
     * outcome: `pull-request-size` was the last one and left when the diffstat
     * ingestion landed. So the card's portal-gap sentence is currently
     * unreachable, and this pins that rather than pretending otherwise -- a
     * test that faked membership would assert nothing about the real estate.
     *
     * The branch is deliberately kept for the next deferred requirement. If
     * one is added to `PORTAL_CANNOT_MEASURE`, restore a test that renders it
     * and asserts the wording, because the two absences must never be
     * conflated again.
     */
    it('attributes nothing to the portal, because nothing is unmeasurable', async () => {
      await render(
        withUnmeasured([
          { id: 'pull-request-size', title: 'Pull request size', weight: 10 },
        ]),
      );

      expect(
        await screen.findByText(/Scored over 90 of 100/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/cannot be measured by the portal/),
      ).not.toBeInTheDocument();
      // It is the repository's own gap now: no merged pull requests to size.
      expect(
        screen.getByText(
          /Pull request size has nothing to measure in this repository/,
        ),
      ).toBeInTheDocument();
    });

    it('blames the repository for what the repository lacks', async () => {
      await render(
        withUnmeasured([
          {
            id: 'code-review-completed',
            title: 'Code review completed',
            weight: 15,
          },
        ]),
      );

      expect(
        await screen.findByText(
          /Code review completed has nothing to measure in this repository/,
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByText(/cannot be measured by the portal/),
      ).not.toBeInTheDocument();
    });

    it('lists several of the repository’s own gaps in one sentence', async () => {
      await render(
        withUnmeasured([
          { id: 'pull-request-size', title: 'Pull request size', weight: 10 },
          {
            id: 'code-review-completed',
            title: 'Code review completed',
            weight: 15,
          },
        ]),
      );

      expect(
        await screen.findByText(
          /Pull request size, Code review completed have nothing to measure/,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText(/Scored over 75 of 100/)).toBeInTheDocument();
    });

    /**
     * The product owner specified the four bands, so the caveat that used to
     * end this sentence became simply false.
     */
    it('no longer calls the band thresholds placeholders', async () => {
      await render(
        withUnmeasured([
          { id: 'pull-request-size', title: 'Pull request size', weight: 10 },
        ]),
      );

      expect(
        await screen.findByText(/Scored over 90 of 100/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/placeholders/)).not.toBeInTheDocument();
      expect(screen.queryByText(/pending sign-off/)).not.toBeInTheDocument();
    });
  });

  it('names metrics that could not be measured, with their forfeited weight', async () => {
    await render(
      ok({
        ...facts,
        score: {
          ...facts.score,
          nominalWeight: 100,
          breakdown: [
            {
              id: 'security-scan',
              title: 'Security scan passing',
              weight: 5,
              detail: 'Not measured yet',
              available: false,
            },
          ],
        },
      }),
    );

    expect(
      await screen.findByText(/not measured yet \(worth 5\)/),
    ).toBeInTheDocument();
  });

  it('renders without a score before the first scoring run', async () => {
    await render(ok({ ...facts, score: undefined }));

    expect(await screen.findByText('261')).toBeInTheDocument();
    expect(screen.queryByText('Health score')).not.toBeInTheDocument();
  });

  it('falls back to a dash for fields Bitbucket does not populate', async () => {
    await render(
      ok({
        ...facts,
        language: undefined,
        projectKey: undefined,
        sizeBytes: undefined,
      }),
    );

    expect(await screen.findAllByText('—')).toHaveLength(3);
  });
  describe('environments', () => {
    const environments = [
      {
        name: 'dev',
        type: 'Test',
        releaseName: '#410',
        commitHash: 'aaaaaaaabbbbbbbb',
        deployedAt: new Date(Date.now() - 3_600_000).toISOString(),
      },
      {
        name: 'production',
        type: 'Production',
        releaseName: '#412',
        commitHash: 'ccccccccdddddddd',
        deployedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      },
    ];

    it('shows what is live in each environment, with its release', async () => {
      await render(ok({ ...facts, environments }));

      expect(await screen.findByText('dev · Test')).toBeInTheDocument();
      expect(screen.getByText('production · Production')).toBeInTheDocument();
      expect(screen.getByText('1 hour ago')).toBeInTheDocument();
      expect(screen.getByText('2 days ago')).toBeInTheDocument();
    });

    it('abbreviates the commit hash rather than wrapping it', async () => {
      await render(ok({ ...facts, environments }));

      expect(await screen.findByText('#412 · ccccccc')).toBeInTheDocument();
      expect(screen.queryByText(/ccccccccdddddddd/)).not.toBeInTheDocument();
    });

    it('says how to fix a repository that records no deployments', async () => {
      // The common cause is a name mismatch, and the team cannot act on
      // "no data" -- only on which name to change.
      await render(ok({ ...facts, environments: [] }));

      expect(
        await screen.findByText(/exactly matches a configured environment/),
      ).toBeInTheDocument();
    });

    it('omits the section entirely when the backend served no such field', async () => {
      await render(ok({ ...facts, environments: undefined }));

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(screen.queryByText('Environments')).not.toBeInTheDocument();
    });
  });
  describe('problems on a low-scoring repository', () => {
    const lowScore = (breakdown: any[], band = 'at-risk'): any => ({
      total: 30,
      band,
      availableWeight: breakdown
        .filter(b => b.available)
        .reduce((sum: number, b: any) => sum + b.weight, 0),
      nominalWeight: 100,
      computedAt: new Date().toISOString(),
      breakdown,
    });

    const metric = (
      id: string,
      title: string,
      weight: number,
      points: number | undefined,
      detail: string,
    ) => ({
      id,
      title,
      weight,
      ...(points === undefined ? {} : { points }),
      detail,
      available: points !== undefined,
    });

    it('leads with the problems, worst first', async () => {
      await render(
        ok({
          ...facts,
          score: lowScore([
            metric('readme-available', 'README available', 10, 0, 'No README'),
            metric(
              'pipeline-passing',
              'Pipeline passing',
              20,
              4,
              '1 of 5 passed',
            ),
            metric('active-commits', 'Active commits', 20, 16, '8 commits'),
          ]),
        }),
      );

      expect(
        await screen.findByText(/Problems — 3 costing 30 points/),
      ).toBeInTheDocument();
      expect(screen.getByText(/16 of 20 points lost/)).toBeInTheDocument();
    });

    it('says nothing for a healthy repository', async () => {
      // 36 repositories are healthy. Bannering them is how a warning gets
      // trained out of people.
      await render(ok(facts));

      expect(await screen.findByText('100')).toBeInTheDocument();
      expect(screen.queryByText(/Problems —/)).not.toBeInTheDocument();
    });

    it('calls a scaffold what it is instead of a decaying service', async () => {
      // 42 of the 59 repositories below healthy have ten or fewer commits ever.
      await render(
        ok({
          ...facts,
          lifetime: { commits: 4, authors: 1 },
          score: lowScore([
            metric('active-commits', 'Active commits', 20, 0, 'no commits'),
            metric('active-contributors', 'Active contributors', 10, 0, 'none'),
          ]),
        }),
      );

      expect(
        await screen.findByText(/Never really developed: 4 commits/),
      ).toBeInTheDocument();
      expect(screen.getByText(/Not a decaying service/)).toBeInTheDocument();
    });

    it('calls a repository with real history abandoned', async () => {
      await render(
        ok({
          ...facts,
          lifetime: { commits: 276, authors: 6 },
          score: lowScore([
            metric('active-commits', 'Active commits', 20, 0, 'no commits'),
          ]),
        }),
      );

      expect(
        await screen.findByText(/Abandoned: 276 commits in its history/),
      ).toBeInTheDocument();
    });

    it('does not list the activity metrics as problems when dormant', async () => {
      // They are one fact three times over; the dormancy line already says it.
      await render(
        ok({
          ...facts,
          lifetime: { commits: 4, authors: 1 },
          score: lowScore([
            metric('active-commits', 'Active commits', 20, 0, 'no commits'),
            metric('active-contributors', 'Active contributors', 10, 0, 'none'),
            metric('branch-hygiene', 'Branch hygiene', 10, 0, 'none active'),
            metric('readme-available', 'README available', 10, 0, 'No README'),
          ]),
        }),
      );

      expect(
        await screen.findByText(/Problems — 1 costing 10 points/),
      ).toBeInTheDocument();
    });

    it('never counts an unmeasurable metric as a problem', async () => {
      await render(
        ok({
          ...facts,
          score: lowScore([
            metric('readme-available', 'README available', 10, 0, 'No README'),
            metric(
              'code-review-completed',
              'Code review completed',
              10,
              undefined,
              'x',
            ),
          ]),
        }),
      );

      expect(
        await screen.findByText(/Problems — 1 costing 10 points/),
      ).toBeInTheDocument();
    });
  });

  describe('ownership proposal', () => {
    const proposal = {
      source: 'commit-history',
      proposed: {
        name: 'Ada Lovelace',
        email: 'ada@demandai.co',
        commits: 34,
      },
      candidates: [
        { name: 'Ada Lovelace', email: 'ada@demandai.co', commits: 34 },
        { name: 'Alan Turing', email: 'alan@demandai.co', commits: 7 },
      ],
      windowCommits: 41,
      windowDays: 90,
      resolvedAt: new Date().toISOString(),
    };

    it('names the suggested owner with the share behind it', async () => {
      await render(ok({ ...facts, ownershipProposal: proposal }));

      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
      expect(screen.getByText(/34 of 41 commits \(83%\)/)).toBeInTheDocument();
    });

    it('says plainly that it is a guess and not the catalog owner', async () => {
      // Someone reading this must not come away thinking ownership is set.
      await render(ok({ ...facts, ownershipProposal: proposal }));

      expect(
        await screen.findByText('Suggested owner — not confirmed'),
      ).toBeInTheDocument();
      expect(screen.getByText(/still owned by/)).toBeInTheDocument();
      expect(screen.getByText('group:default/unowned')).toBeInTheDocument();
    });

    it('lists the runners-up so the suggestion can be judged', async () => {
      await render(ok({ ...facts, ownershipProposal: proposal }));

      expect(
        await screen.findByText(/Ada Lovelace \(34\) · Alan Turing \(7\)/),
      ).toBeInTheDocument();
    });

    it('names nobody when commits are spread too evenly', async () => {
      await render(
        ok({
          ...facts,
          ownershipProposal: {
            ...proposal,
            proposed: undefined,
            candidates: [
              { name: 'Ada Lovelace', commits: 20 },
              { name: 'Alan Turing', commits: 20 },
            ],
          },
        }),
      );

      expect(
        await screen.findByText(/commits are spread too evenly/),
      ).toBeInTheDocument();
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    });

    it('says there is no history to work from when there are no candidates', async () => {
      await render(
        ok({
          ...facts,
          ownershipProposal: {
            ...proposal,
            proposed: undefined,
            candidates: [],
            windowCommits: 0,
          },
        }),
      );

      expect(
        await screen.findByText(/No commits in the last 90 days/),
      ).toBeInTheDocument();
    });

    it('omits the section before the first ownership pass', async () => {
      await render(ok({ ...facts, ownershipProposal: undefined }));

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(
        screen.queryByText('Suggested owner — not confirmed'),
      ).not.toBeInTheDocument();
    });

    describe('a confirmed owner', () => {
      const confirmed = {
        ...proposal,
        source: OWNERSHIP_SOURCE_REGISTER,
      };

      it('does not call a confirmed owner a suggestion', async () => {
        // The defect this exists for: once the register landed, 89 repositories
        // had a confirmed owner and the card still called every one a guess.
        await render(ok({ ...facts, ownershipProposal: confirmed }));

        expect(
          await screen.findByText('Owner — confirmed'),
        ).toBeInTheDocument();
        expect(
          screen.queryByText('Suggested owner — not confirmed'),
        ).not.toBeInTheDocument();
      });

      it('does not claim the repository is unowned in the catalog', async () => {
        // It says user:default/... there now, so the old line was simply false.
        await render(ok({ ...facts, ownershipProposal: confirmed }));

        expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
        expect(
          screen.queryByText('group:default/unowned'),
        ).not.toBeInTheDocument();
        expect(screen.queryByText(/and a guess/)).not.toBeInTheDocument();
      });

      it('says where the confirmation came from', async () => {
        await render(ok({ ...facts, ownershipProposal: confirmed }));

        expect(
          await screen.findByText(/Confirmed in the ownership register/),
        ).toBeInTheDocument();
      });

      it('reports commits as corroboration, not as the reason', async () => {
        // The share must never lead: this owner does not rest on commits.
        await render(ok({ ...facts, ownershipProposal: confirmed }));

        const detail = await screen.findByText(
          /Confirmed in the ownership register/,
        );
        expect(detail.textContent).toMatch(
          /Confirmed in the ownership register.*Also 34 of 41/s,
        );
      });

      it('omits the commit note entirely for an owner who has not committed', async () => {
        await render(
          ok({
            ...facts,
            ownershipProposal: {
              ...confirmed,
              proposed: {
                name: 'Ada Lovelace',
                email: 'ada@demandai.co',
                commits: 0,
              },
            },
          }),
        );

        const detail = await screen.findByText(
          /Confirmed in the ownership register/,
        );
        expect(detail.textContent).not.toMatch(/Also/);
      });
    });
  });
  describe('pipeline states', () => {
    const pipelines = {
      successful: 14,
      failed: 3,
      cancelled: 2,
      running: 1,
      successRate: 14 / 17,
      lastResult: 'SUCCESSFUL',
      lastRunAt: new Date(Date.now() - 3_600_000).toISOString(),
    };

    it('shows all four states section 6 asks for', async () => {
      await render(ok({ ...facts, pipelines }));

      expect(
        await screen.findByText('Recent pipeline runs'),
      ).toBeInTheDocument();
      for (const label of ['Passed', 'Failed', 'Cancelled', 'Running']) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
      expect(screen.getByText('14')).toBeInTheDocument();
      expect(screen.getByText('2')).toBeInTheDocument();
    });

    it('shows a success rate that excludes cancelled runs', async () => {
      // 14 of 17 judged, not 14 of 19 finished.
      await render(ok({ ...facts, pipelines }));

      expect(await screen.findByText('82%')).toBeInTheDocument();
    });

    it('omits the rate when there is nothing to judge', async () => {
      await render(
        ok({
          ...facts,
          pipelines: { ...pipelines, successRate: undefined },
        }),
      );

      expect(await screen.findByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByText('Success rate')).not.toBeInTheDocument();
    });

    it('hides the section for a repository with no runs at all', async () => {
      // 48 of 95 repositories have no CI. An empty row of zeroes would be
      // noise on half the estate.
      await render(
        ok({
          ...facts,
          pipelines: {
            successful: 0,
            failed: 0,
            cancelled: 0,
            running: 0,
          },
        }),
      );

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(
        screen.queryByText('Recent pipeline runs'),
      ).not.toBeInTheDocument();
    });

    it('omits the section entirely when the backend served no such field', async () => {
      await render(ok({ ...facts, pipelines: undefined }));

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(
        screen.queryByText('Recent pipeline runs'),
      ).not.toBeInTheDocument();
    });
  });
  describe('stale branches', () => {
    /**
     * The card must show the figure the score is built on. `stale` counts the
     * default branch and every deliberate long-lived branch, so showing it made
     * the card read "1 of 14" beside a scorecard saying "No stale branches to
     * delete" -- which reads as a defect in one of the two.
     */
    it('counts only the branches somebody ought to delete', async () => {
      await render(
        ok({
          ...facts,
          branches: {
            total: 14,
            active: 2,
            stale: 12,
            staleActionable: 9,
            staleExempt: 3,
            stalest: [],
          },
        }),
      );

      expect(await screen.findByText('Stale branches')).toBeInTheDocument();
      expect(screen.getByText('9 of 14')).toBeInTheDocument();
      expect(screen.getByText('3 exempt as deliberate')).toBeInTheDocument();
    });

    it('says nothing about exemptions when there are none', async () => {
      await render(
        ok({
          ...facts,
          branches: {
            total: 5,
            active: 4,
            stale: 1,
            staleActionable: 1,
            staleExempt: 0,
            stalest: [],
          },
        }),
      );

      expect(await screen.findByText('1 of 5')).toBeInTheDocument();
      expect(screen.queryByText(/exempt/)).not.toBeInTheDocument();
    });
  });

  describe('peer review', () => {
    /**
     * A self-approval is not a review, and this card used to say otherwise:
     * measured across the estate it reported 265 of 365 pull requests
     * "reviewed" where a second person had looked at 85. It must agree with
     * the scorecard, which scores peer approvals.
     */
    it('counts approvals by somebody other than the author', async () => {
      await render(
        ok({
          ...facts,
          reviews: { merged: 10, approved: 8, peerApproved: 3, open: 0 },
        }),
      );

      expect(
        await screen.findByText('Peer reviewed (90d)'),
      ).toBeInTheDocument();
      expect(screen.getByText('3 of 10')).toBeInTheDocument();
    });

    it('names the self-approvals, because that is the gap to close', async () => {
      await render(
        ok({
          ...facts,
          reviews: { merged: 10, approved: 8, peerApproved: 3, open: 0 },
        }),
      );

      expect(
        await screen.findByText('merged PRs · 5 self-approved only'),
      ).toBeInTheDocument();
    });

    it('says nothing about self-approval when there was none', async () => {
      await render(
        ok({
          ...facts,
          reviews: { merged: 10, approved: 10, peerApproved: 10, open: 0 },
        }),
      );

      expect(await screen.findByText('10 of 10')).toBeInTheDocument();
      expect(screen.queryByText(/self-approved/)).not.toBeInTheDocument();
    });
  });

  describe('review time', () => {
    it('shows review time alongside merge duration, as two measurements', async () => {
      await render(
        ok({
          ...facts,
          reviews: {
            merged: 53,
            approved: 25,
            peerApproved: 25,
            open: 0,
            medianReviewHours: 4.5,
            medianMergeHours: 20,
          },
        }),
      );

      expect(await screen.findByText('Median review time')).toBeInTheDocument();
      expect(screen.getByText('Median merge time')).toBeInTheDocument();
      expect(screen.getByText('4.5 hours')).toBeInTheDocument();
      expect(screen.getByText('20 hours')).toBeInTheDocument();
    });

    it('omits review time when nothing in the window was approved', async () => {
      await render(
        ok({
          ...facts,
          reviews: {
            merged: 10,
            approved: 0,
            peerApproved: 0,
            open: 0,
            medianMergeHours: 3,
          },
        }),
      );

      expect(await screen.findByText('Median merge time')).toBeInTheDocument();
      expect(screen.queryByText('Median review time')).not.toBeInTheDocument();
    });
  });
  describe('lifetime facts', () => {
    const lifetime = {
      commits: 2,
      authors: 1,
      // Distinct dates: a repository started a year ago whose last commit was
      // seven months ago, which is what these look like in the real estate.
      firstCommitAt: new Date(Date.now() - 371 * 86_400_000).toISOString(),
      lastCommitAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    };

    it('shows a two-commit repository as two commits, not as empty', async () => {
      // The whole point: through a 90-day window this looked identical to an
      // abandoned mature service.
      await render(
        ok({
          ...facts,
          activity: { windowDays: 90, commits: 0, authors: 0 },
          lifetime,
        }),
      );

      expect(await screen.findByText('Commits (all time)')).toBeInTheDocument();
      expect(screen.getByText('Contributors (all time)')).toBeInTheDocument();
      expect(screen.getByText('First commit')).toBeInTheDocument();
      expect(screen.getByText('Newest commit')).toBeInTheDocument();
      expect(screen.getByText('1 year ago')).toBeInTheDocument();
      expect(screen.getByText('6 months ago')).toBeInTheDocument();
    });

    it('hides the section for a repository with no history at all', async () => {
      await render(ok({ ...facts, lifetime: { commits: 0, authors: 0 } }));

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(screen.queryByText('Commits (all time)')).not.toBeInTheDocument();
    });

    it('omits the section entirely when the backend served no such field', async () => {
      await render(ok({ ...facts, lifetime: undefined }));

      expect(await screen.findByText('261')).toBeInTheDocument();
      expect(screen.queryByText('Commits (all time)')).not.toBeInTheDocument();
    });
  });
});
