import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import { DatabaseManager } from '@backstage/backend-defaults/database';
import {
  fleetDatabaseClient,
  resetFleetDatabaseClientForTests,
} from './fleetDatabase';

jest.mock('@backstage/backend-defaults/database', () => ({
  DatabaseManager: { fromConfig: jest.fn() },
}));

const fromConfig = DatabaseManager.fromConfig as jest.Mock;

function stubManager(client: unknown = { fake: 'client' }) {
  const getClient = jest.fn().mockResolvedValue(client);
  const forPlugin = jest.fn().mockReturnValue({ getClient });
  fromConfig.mockReturnValue({ forPlugin });
  return { forPlugin, getClient };
}

const deps = () => ({
  logger: mockServices.logger.mock(),
  lifecycle: mockServices.rootLifecycle.mock(),
});

describe('fleetDatabaseClient', () => {
  const config = new ConfigReader({});

  beforeEach(() => {
    jest.clearAllMocks();
    resetFleetDatabaseClientForTests();
  });

  it('asks for the fleet plugin, not the caller plugin', async () => {
    const { forPlugin } = stubManager();

    await fleetDatabaseClient(config as any, deps());

    expect(forPlugin).toHaveBeenCalledWith('fleet', expect.anything());
  });

  it('opens exactly one pool however many consumers ask', async () => {
    // The regression this exists for: a manager per call gave the catalog
    // module and the search module a pool each on top of the fleet plugin's
    // own. Three pools to one database was enough, under concurrent plugin
    // startup, to starve the catalog's auth service of a connection -- which
    // took the catalog's routes down and left every page unable to load an
    // entity.
    const { getClient } = stubManager();

    await fleetDatabaseClient(config as any, deps());
    await fleetDatabaseClient(config as any, deps());
    await fleetDatabaseClient(config as any, deps());

    expect(fromConfig).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenCalledTimes(1);
  });

  it('hands every consumer the same client', async () => {
    const client = { marker: 'shared' };
    stubManager(client);

    const first = await fleetDatabaseClient(config as any, deps());
    const second = await fleetDatabaseClient(config as any, deps());

    expect(first).toBe(client);
    expect(second).toBe(client);
  });

  it('shares the in-flight promise rather than racing two pools open', async () => {
    // Both consumers initialise concurrently at startup, so the second must
    // join the first attempt instead of starting its own.
    stubManager();

    await Promise.all([
      fleetDatabaseClient(config as any, deps()),
      fleetDatabaseClient(config as any, deps()),
    ]);

    expect(fromConfig).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so a later caller can still succeed', async () => {
    // A consumer initialising before the database is reachable would otherwise
    // poison every caller for the life of the process.
    const getClient = jest
      .fn()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce({ marker: 'recovered' });
    fromConfig.mockReturnValue({
      forPlugin: jest.fn().mockReturnValue({ getClient }),
    });

    await expect(fleetDatabaseClient(config as any, deps())).rejects.toThrow(
      'connection refused',
    );

    await expect(fleetDatabaseClient(config as any, deps())).resolves.toEqual({
      marker: 'recovered',
    });
  });
});
