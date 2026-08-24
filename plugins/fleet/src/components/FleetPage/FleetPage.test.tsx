import { fetchApiRef } from '@backstage/frontend-plugin-api';
import {
  renderInTestApp,
  TestApiProvider,
} from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import type { FleetOverview } from '@internal/backstage-plugin-fleet-common';
import { FleetPage } from './FleetPage';

const overview: FleetOverview = {
  generatedAt: '2026-08-21T12:00:00.000Z',
  nominalWeight: 100,
  counts: { healthy: 1, needsAttention: 1, critical: 2, unscored: 1 },
  repositories: [
    {
      entityRef: 'component:default/dead-repo',
      slug: 'dead-repo',
      name: 'dead-repo',
      projectKey: 'DDS',
      score: {
        total: 4,
        band: 'critical',
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
    expect(screen.getByText('shaky')).toBeInTheDocument();
    expect(screen.getByText('oxp-backend')).toBeInTheDocument();
    expect(screen.getByText('brand-new')).toBeInTheDocument();
  });

  it('preserves the order the API returned, worst first', async () => {
    await render(ok(overview));
    await screen.findByText('dead-repo');

    const links = screen.getAllByRole('link').map(a => a.textContent);
    expect(links).toEqual(['dead-repo', 'shaky', 'oxp-backend', 'brand-new']);
  });

  it('links each repository to its catalog entity', async () => {
    await render(ok(overview));

    const link = await screen.findByRole('link', { name: 'oxp-backend' });
    expect(link).toHaveAttribute(
      'href',
      '/catalog/default/component/oxp-backend',
    );
  });

  it('shows the band summary including the unscored', async () => {
    await render(ok(overview));

    expect(
      await screen.findByText(/2 critical .* 1 needs\s*attention .* 1 healthy/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 not yet scored/)).toBeInTheDocument();
  });

  it('shows how much weight each score was measured over', async () => {
    await render(ok(overview));

    expect(await screen.findByText('45 / 100')).toBeInTheDocument();
    expect(screen.getAllByText('85 / 100')).toHaveLength(2);
  });

  it('marks an unscored repository plainly rather than as zero', async () => {
    await render(ok(overview));

    expect(await screen.findByText('Not scored')).toBeInTheDocument();
  });

  it('says when a repository has never been committed to', async () => {
    await render(ok(overview));

    expect(await screen.findAllByText('Never')).toHaveLength(2);
  });

  it('handles an estate with nothing in it', async () => {
    await render(
      ok({
        ...overview,
        counts: { healthy: 0, needsAttention: 0, critical: 0, unscored: 0 },
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
      await screen.findByText(/Could not load the fleet/),
    ).toBeInTheDocument();
  });
});
