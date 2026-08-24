import type { Entity } from '@backstage/catalog-model';
import { fetchApiRef } from '@backstage/frontend-plugin-api';
import {
  renderInTestApp,
  TestApiProvider,
} from '@backstage/frontend-test-utils';
import { screen } from '@testing-library/react';
import type { RepositoryFacts } from '@internal/backstage-plugin-fleet-common';
import { RepositoryFactsCard } from './RepositoryFactsCard';

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
    await render(ok(facts));

    expect(
      await screen.findByText(/20 \/ 20 — 261 commits in 90 days/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/10 \/ 10 — 5 contributors in 90 days/),
    ).toBeInTheDocument();
  });

  it('flags a partial score rather than presenting it as complete', async () => {
    await render(
      ok({
        ...facts,
        score: { ...facts.score, availableWeight: 30, nominalWeight: 100 },
      }),
    );

    expect(await screen.findByText(/Provisional/)).toBeInTheDocument();
    expect(screen.getByText('30 of 100 weight')).toBeInTheDocument();
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
});
