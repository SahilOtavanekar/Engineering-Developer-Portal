import { fetchApiRef } from '@backstage/frontend-plugin-api';
import {
  renderInTestApp,
  TestApiProvider,
} from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import userEvent from '@testing-library/user-event';
import { FleetPage } from './FleetPage';

const overview: FleetOverview = {
  generatedAt: '2026-08-21T12:00:00.000Z',
  nominalWeight: 100,
  counts: {
    excellent: 0,
    healthy: 1,
    needsAttention: 1,
    atRisk: 2,
    unscored: 1,
  },
  repositories: [
    {
      entityRef: 'component:default/dead-repo',
      slug: 'dead-repo',
      name: 'dead-repo',
      projectKey: 'DDS',
      score: {
        total: 4,
        band: 'at-risk',
        availableWeight: 45,
        computedAt: '2026-08-21T11:00:00.000Z',
      },
    },
    {
      entityRef: 'component:default/idle-service',
      slug: 'idle-service',
      name: 'idle-service',
      projectKey: 'DDS',
      score: {
        total: 6,
        band: 'at-risk',
        availableWeight: 45,
        computedAt: '2026-08-21T11:00:00.000Z',
      },
    },
    {
      entityRef: 'component:default/shaky',
      slug: 'shaky',
      name: 'shaky',
      projectKey: 'OXP',
      lastCommitAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      score: {
        total: 55,
        band: 'needs-attention',
        availableWeight: 85,
        computedAt: '2026-08-21T11:00:00.000Z',
      },
    },
    {
      entityRef: 'component:default/oxp-backend',
      slug: 'oxp-backend',
      name: 'oxp-backend',
      projectKey: 'DDS',
      proposedOwner: {
        name: 'Brijesh Gupta',
        email: 'brijesh.gupta@demandai.co',
        commits: 187,
      },
      lastCommitAt: new Date(Date.now() - 86_400_000).toISOString(),
      score: {
        total: 88,
        band: 'healthy',
        availableWeight: 85,
        computedAt: '2026-08-21T11:00:00.000Z',
      },
    },
    {
      entityRef: 'component:default/brand-new',
      slug: 'brand-new',
      name: 'brand-new',
    },
  ],
};

function fetchApi(handler: () => Partial<Response>) {
  return { fetch: jest.fn(async () => handler() as Response) };
}

async function render(handler: () => Partial<Response>) {
  await renderInTestApp(
    <TestApiProvider apis={[[fetchApiRef, fetchApi(handler)]]}>
      <FleetPage />
    </TestApiProvider>,
  );
}

const ok = (body: unknown) => () => ({
  ok: true,
  status: 200,
  json: async () => body,
});

describe('FleetPage', () => {
  it('lists every repository', async () => {
    await render(ok(overview));

    expect(await screen.findByText('dead-repo')).toBeInTheDocument();
    expect(screen.getByText('idle-service')).toBeInTheDocument();
    expect(screen.getByText('shaky')).toBeInTheDocument();
    expect(screen.getByText('oxp-backend')).toBeInTheDocument();
    expect(screen.getByText('brand-new')).toBeInTheDocument();
  });

  it('preserves the order the API returned, worst first', async () => {
    await render(ok(overview));
    await screen.findByText('dead-repo');

    const links = screen.getAllByRole('link').map(a => a.textContent);
    expect(links).toEqual([
      'dead-repo',
      'idle-service',
      'shaky',
      'oxp-backend',
      'brand-new',
    ]);
  });

  it('links each repository to its catalog entity', async () => {
    await render(ok(overview));

    const link = await screen.findByRole('link', { name: 'oxp-backend' });
    expect(link).toHaveAttribute(
      'href',
      '/catalog/default/component/oxp-backend',
    );
  });

  it('offers a band filter for each populated band', async () => {
    await render(ok(overview));

    // The bar segments carry the counts and double as the band filter.
    expect(
      await screen.findByRole('button', {
        name: 'At risk (2)',
        pressed: false,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Not scored \(1\)/ }),
    ).toBeInTheDocument();
  });

  it('marks an unscored repository plainly rather than as zero', async () => {
    await render(ok(overview));

    expect(await screen.findByText('Not scored')).toBeInTheDocument();
  });

  it('says when a repository has never been committed to', async () => {
    await render(ok(overview));

    expect(await screen.findAllByText('Never')).toHaveLength(3);
  });

  it('handles an estate with nothing in it', async () => {
    await render(
      ok({
        ...overview,
        counts: {
          excellent: 0,
          healthy: 0,
          needsAttention: 0,
          atRisk: 0,
          unscored: 0,
        },
        repositories: [],
      }),
    );

    expect(
      await screen.findByText(/No repositories ingested yet/),
    ).toBeInTheDocument();
  });

  it('reports a failure rather than rendering an empty table', async () => {
    await render(() => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }));

    expect(
      await screen.findByText(/Could not load the health dashboard/),
    ).toBeInTheDocument();
  });

  describe('filtering', () => {
    it('reports the total when nothing is filtered', async () => {
      await render(ok(overview));

      expect(await screen.findByText('5 repositories')).toBeInTheDocument();
    });

    it('narrows to a band when its segment is clicked', async () => {
      await render(ok(overview));
      const atRisk = await screen.findByRole('button', {
        name: 'At risk (2)',
      });

      await userEvent.click(atRisk);

      expect(
        screen.getByText('Showing 2 of 5 repositories'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'oxp-backend' })).toBeNull();
      expect(
        screen.getByRole('link', { name: 'dead-repo' }),
      ).toBeInTheDocument();
    });

    it('clears a band filter when its segment is clicked again', async () => {
      await render(ok(overview));
      const atRisk = await screen.findByRole('button', {
        name: 'At risk (2)',
      });

      await userEvent.click(atRisk);
      await userEvent.click(atRisk);

      expect(screen.getByText('5 repositories')).toBeInTheDocument();
    });

    it('narrows to the unscored', async () => {
      await render(ok(overview));

      await userEvent.click(
        await screen.findByRole('button', { name: /Not scored/ }),
      );

      expect(
        screen.getByRole('link', { name: 'brand-new' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'dead-repo' })).toBeNull();
    });

    it('filters by name as you type', async () => {
      await render(ok(overview));
      const box = await screen.findByLabelText('Filter repositories by name');

      await userEvent.type(box, 'oxp');

      expect(
        screen.getByRole('link', { name: 'oxp-backend' }),
      ).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'shaky' })).toBeNull();
    });

    it('says so plainly when nothing matches', async () => {
      await render(ok(overview));
      const box = await screen.findByLabelText('Filter repositories by name');

      await userEvent.type(box, 'nothing-matches-this');

      expect(
        screen.getByText('No repositories match these filters.'),
      ).toBeInTheDocument();
    });

    it('restores everything with Clear filters', async () => {
      await render(ok(overview));
      const box = await screen.findByLabelText('Filter repositories by name');
      await userEvent.type(box, 'oxp');

      await userEvent.click(
        screen.getByRole('button', { name: 'Clear filters' }),
      );

      expect(screen.getByText('5 repositories')).toBeInTheDocument();
    });
  });
});

describe('proposed owner column', () => {
  it('shows the suggested owner for a repository that has one', async () => {
    await render(ok(overview));

    expect(await screen.findByText('Brijesh Gupta')).toBeInTheDocument();
  });

  it('heads the column "Owner", now that most of them are confirmed', async () => {
    // The question mark was right when every name was a guess and the catalog
    // recorded all 95 as unowned. 89 of 95 are now confirmed from the
    // ownership register, so hedging all of them understates it. The 6
    // remaining guesses are marked by the `unconfirmed-owner` tag instead.
    await render(ok(overview));

    expect(await screen.findByText('Owner')).toBeInTheDocument();
    expect(screen.queryByText('Owner?')).not.toBeInTheDocument();
  });

  it('heads the band column "Status"', async () => {
    await render(ok(overview));

    expect(await screen.findByText('Status')).toBeInTheDocument();
  });

  it('dashes a repository nobody clearly owns rather than guessing', async () => {
    await render(ok(overview));
    await screen.findByText('Brijesh Gupta');

    // Four of the five rows have no proposal.
    const row = screen.getByRole('link', { name: 'dead-repo' }).closest('tr');
    expect(row?.textContent).not.toMatch(/Gupta/);
  });

  it('falls back to the address when there is no display name', async () => {
    await render(
      ok({
        ...overview,
        repositories: [
          {
            ...overview.repositories[3],
            proposedOwner: { email: 'ada@demandai.co', commits: 12 },
          },
        ],
      }),
    );

    expect(await screen.findByText('ada@demandai.co')).toBeInTheDocument();
  });
});
