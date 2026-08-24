import { createRouteRef } from '@backstage/frontend-plugin-api';

/**
 * Route for the fleet overview page.
 *
 * Not optional decoration: `AppNav` drops any page extension whose route ref
 * is missing, before it even looks at the title or icon. A page without one
 * still routes and renders, but never appears in the sidebar.
 */
export const fleetRouteRef = createRouteRef();
