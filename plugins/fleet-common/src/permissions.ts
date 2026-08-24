import { createPermission } from '@backstage/plugin-permission-common';

/**
 * Reading repository facts: commit activity, sizes, sync state.
 *
 * Declared as routes are built rather than when enforcement arrives. The
 * `allow-all-policy` currently in place permits everything, so this grants
 * nothing today -- but retrofitting permissions across every route once a real
 * policy lands is materially harder than declaring them up front.
 */
export const fleetRepositoryReadPermission = createPermission({
  name: 'fleet.repository.read',
  attributes: { action: 'read' },
});

export const fleetPermissions = [fleetRepositoryReadPermission];
