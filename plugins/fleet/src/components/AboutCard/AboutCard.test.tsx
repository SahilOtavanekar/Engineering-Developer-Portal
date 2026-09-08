import type { Entity } from '@backstage/catalog-model';
import { renderInTestApp } from '@backstage/frontend-test-utils';
import { entityRouteRef } from '@backstage/plugin-catalog-react';
import { screen } from '@testing-library/react';
import { AboutCard } from './AboutCard';

const entity = (overrides: Partial<Entity> = {}): Entity => ({
  apiVersion: 'backstage.io/v1alpha1',
  kind: 'Component',
  metadata: {
    name: 'oxp-backend',
    namespace: 'default',
    description: 'The OXP backend service.',
    tags: ['confirmed-owner', 'node-js'],
    annotations: {
      'backstage.io/source-location':
        'url:https://bitbucket.org/demandai/oxp-backend/src/main/',
    },
    ...overrides.metadata,
  },
  spec: { type: 'service', lifecycle: 'experimental', ...overrides.spec },
  relations: [
    {
      type: 'ownedBy',
      targetRef: 'group:default/platform',
    },
    ...(overrides.relations ?? []),
  ],
  ...overrides,
});

// `EntityRefLinks` resolves the catalog entity route, and `useRouteRef`
// throws outright when that route is not mounted -- the same failure mode the
// catalog-graph card hit. The real app always has it; the test app must be told.
const render = (e: Entity) =>
  renderInTestApp(<AboutCard entity={e} />, {
    mountedRoutes: { '/catalog/:namespace/:kind/:name': entityRouteRef },
  });

describe('AboutCard', () => {
  it('shows the catalog facts the stock card showed', async () => {
    await render(entity());

    expect(await screen.findByText('About')).toBeInTheDocument();
    expect(screen.getByText('The OXP backend service.')).toBeInTheDocument();
    expect(screen.getByText('Component')).toBeInTheDocument();
    expect(screen.getByText('service')).toBeInTheDocument();
    expect(screen.getByText('confirmed-owner')).toBeInTheDocument();
    expect(screen.getByText('node-js')).toBeInTheDocument();
  });

  it('does not show the lifecycle, which is unknown across the estate', () => {
    // `spec.lifecycle` is still SET on the fixture, and still required by the
    // Component schema -- the point is that the card no longer renders it.
    // Asserting its absence rather than deleting the old assertion, so that
    // restoring the row fails a test instead of passing quietly.
    expect(entity().spec).toHaveProperty('lifecycle', 'experimental');
  });

  it('calls the System a Project, matching the catalog column', async () => {
    // The row reads the `partOf` RELATION, not `spec.system` -- the first
    // version of this test set the spec field and found no row at all.
    await render(
      entity({
        relations: [{ type: 'partOf', targetRef: 'system:default/mdlh' }],
      }),
    );

    expect(await screen.findByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('System')).not.toBeInTheDocument();
    expect(screen.queryByText('Lifecycle')).not.toBeInTheDocument();
  });

  it('drops Project and Type on a Project, where neither applies', async () => {
    // A System carries no `spec.type` and cannot belong to a System, so those
    // rows are omitted rather than shown as em-dashes. Kind reads "Project".
    await render(
      entity({
        kind: 'System',
        metadata: { name: 'mdlh', title: 'MDLH' },
        spec: {},
        relations: [],
      }),
    );

    expect(await screen.findByText('Kind')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.queryByText('Type')).not.toBeInTheDocument();
  });

  it('links to the source location from the annotation', async () => {
    await render(entity());

    const link = await screen.findByRole('link', { name: 'View source' });
    expect(link).toHaveAttribute(
      'href',
      'https://bitbucket.org/demandai/oxp-backend/src/main/',
    );
  });

  it('omits the source link when the annotation is not a URL', async () => {
    // `managed-by-location` can be a `file:` target on locally registered
    // entities, and rendering that as a link gives a dead one.
    await render(
      entity({
        metadata: {
          name: 'oxp-backend',
          annotations: { 'backstage.io/source-location': 'file:/tmp/x.yaml' },
        },
      }),
    );

    expect(
      screen.queryByRole('link', { name: 'View source' }),
    ).not.toBeInTheDocument();
  });

  it('says so plainly when a field is absent rather than leaving a gap', async () => {
    await render(
      entity({
        metadata: { name: 'bare' },
        spec: {},
        relations: [],
      }),
    );

    expect(await screen.findByText('No description')).toBeInTheDocument();
    // Owner, project, type and tags are all absent on this Component. Was 4
    // and included lifecycle, which the card no longer renders at all -- the
    // em-dash for every field that DOES apply is deliberate and this test is
    // what protects it.
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(4);
  });

  it('shows the owner the catalog records, not a guess', async () => {
    await render(entity());

    expect(await screen.findByText(/platform/)).toBeInTheDocument();
  });
});
