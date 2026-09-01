import {
  createFrontendPlugin,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import { EntityCardBlueprint } from '@backstage/plugin-catalog-react/alpha';
import AssessmentIcon from '@material-ui/icons/Assessment';
import GroupIcon from '@material-ui/icons/Group';
import { fleetRouteRef, productivityRouteRef } from './routes';

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
/**
 * Replaces the stock catalog About card.
 *
 * The stock one lays its fields out in `{ initial: 1, sm: 2, lg: 3 }` columns
 * resolved against the **viewport**, while the card sits in the entity
 * layout's narrow `1fr` sidebar -- so on a wide screen it rendered three
 * columns into a ~350px card and overflowed into a horizontal scrollbar.
 *
 * `type: 'info'` puts this in the same slot, and the filter matches the stock
 * card's exactly, so Users and Groups keep the behaviour they already had:
 * neither ever showed an About card.
 */
export const aboutCard = EntityCardBlueprint.make({
  name: 'about',
  params: {
    type: 'info',
    filter: { $not: { kind: { $in: ['user', 'group'] } } },
    loader: () =>
      import('./components/AboutCard').then(m => <m.EntityAboutCard />),
  },
});

export const fleetPage = PageBlueprint.make({
  params: {
    path: '/fleet',
    title: 'Health Dashboard',
    icon: <AssessmentIcon />,
    routeRef: fleetRouteRef,
    loader: () => import('./components/FleetPage').then(m => <m.FleetPage />),
  },
});

/**
 * Per-engineer productivity, requirement 8.
 *
 * A separate page rather than a tab on the fleet view: it answers a different
 * question about different subjects -- people, not repositories -- and it is the
 * page most likely to need access control the moment permissions are real.
 */
export const productivityPage = PageBlueprint.make({
  name: 'productivity',
  params: {
    path: '/productivity',
    title: 'Productivity',
    icon: <GroupIcon />,
    routeRef: productivityRouteRef,
    loader: () =>
      import('./components/ProductivityPage').then(m => <m.ProductivityPage />),
  },
});

export const fleetPlugin = createFrontendPlugin({
  pluginId: 'fleet',
  extensions: [fleetPage, productivityPage, repositoryFactsCard, aboutCard],
  routes: {
    root: fleetRouteRef,
    productivity: productivityRouteRef,
  },
});
