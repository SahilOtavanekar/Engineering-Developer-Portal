import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import AssessmentIcon from '@material-ui/icons/Assessment';
import { fleetRouteRef } from './routes';

/** Annotation the Bitbucket entity provider stamps on every repository. */
const BITBUCKET_SLUG_ANNOTATION = 'fleet.backstage.io/bitbucket-slug';

export const repositoryFactsCard = EntityCardBlueprint.make({
  name: 'repository-facts',
  params: {
    // Only entities the fleet ingestion actually knows about. A function
    // filter rather than an expression string: unambiguous and typechecked.
    filter: entity =>
      Boolean(entity.metadata.annotations?.[BITBUCKET_SLUG_ANNOTATION]),
    loader: () =>
      import('./components/RepositoryFactsCard').then(m => (
        <m.EntityRepositoryFactsCard />
      )),
  },
});

/**
 * The fleet overview.
 *
 * The route ref and icon are both load-bearing. `AppNav` drops a page
 * extension outright -- silently, with no warning -- if it lacks a route ref,
 * a title, or an icon. Such a page still routes and still renders when
 * visited; it simply never appears in the sidebar.
 */
export const fleetPage = PageBlueprint.make({
  params: {
    path: '/fleet',
    title: 'Fleet',
    icon: <AssessmentIcon />,
    routeRef: fleetRouteRef,
    loader: () => import('./components/FleetPage').then(m => <m.FleetPage />),
  },
});

export const fleetPlugin = createFrontendPlugin({
  pluginId: 'fleet',
  extensions: [fleetPage, repositoryFactsCard],
  routes: {
    root: fleetRouteRef,
  },
});
