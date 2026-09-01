import { coreExtensionData } from '@backstage/frontend-plugin-api';
import { createExtensionTester } from '@backstage/frontend-test-utils';
import { fleetPage } from './plugin';
import { fleetRouteRef } from './routes';

/**
 * These guard a failure mode that is invisible at runtime.
 *
 * `AppNav` builds the sidebar from page extensions and discards any that lack
 * a route ref, a title, or an icon -- returning an empty list, with no warning
 * of any kind. Such a page still routes correctly and still renders when
 * visited directly; it simply never appears in the sidebar.
 *
 * All three are checked because getting one right is not enough: this page was
 * missing the icon, then still missing the route ref, and nothing failed to
 * say so either time.
 */
describe('fleetPage', () => {
  const tester = () => createExtensionTester(fleetPage);

  it('exposes a route path', () => {
    expect(tester().get(coreExtensionData.routePath)).toBe('/fleet');
  });

  it('exposes a route ref, the first thing the sidebar checks for', () => {
    expect(tester().get(coreExtensionData.routeRef)).toBe(fleetRouteRef);
  });

  it('exposes a title', () => {
    expect(tester().get(coreExtensionData.title)).toBe('Health Dashboard');
  });

  it('exposes an icon', () => {
    expect(tester().get(coreExtensionData.icon)).toBeDefined();
  });

  it('renders a page element', () => {
    expect(tester().get(coreExtensionData.reactElement)).toBeDefined();
  });
});
