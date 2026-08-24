import { mockServices } from '@backstage/backend-test-utils';
import { ConfigReader } from '@backstage/config';
import type {
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketRepository } from '../bitbucket/types';
import {
  ANNOTATION_DEFAULT_BRANCH,
  ANNOTATION_PROJECT_KEY,
  ANNOTATION_SLUG,
  ANNOTATION_WORKSPACE,
  BitbucketRepositoryEntityProvider,
} from './BitbucketRepositoryEntityProvider';
import { toEntityName } from './entityName';
import { stubBitbucketClient } from '../__testUtils__/bitbucket';

function repository(
  overrides: Partial<BitbucketRepository> = {},
): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug: 'oxp-backend',
    name: 'OXP Backend',
    url: 'https://bitbucket.org/demandai/oxp-backend',
    isPrivate: true,
    createdAt: '2023-05-01T10:00:00+00:00',
    updatedAt: '2026-08-19T12:00:00+00:00',
    ...overrides,
  };
}

/** Captures whatever the provider applies, and runs scheduled work inline. */
function harness(repositories: BitbucketRepository[]) {
  const mutations: EntityProviderMutation[] = [];
  const connection: EntityProviderConnection = {
    applyMutation: async mutation => {
      mutations.push(mutation);
    },
    refresh: async () => {},
  };

  const provider = new BitbucketRepositoryEntityProvider({
    workspace: 'demandai',
    client: new FakeBitbucketClient(repositories),
    logger: mockServices.logger.mock(),
    taskRunner: {
      run: async task => {
        await task.fn(new AbortController().signal);
      },
    },
  });

  return { provider, connection, mutations };
}

/** The single entity produced from one repository. */
async function entityFor(overrides: Partial<BitbucketRepository> = {}) {
  const { provider, connection, mutations } = harness([repository(overrides)]);
  await provider.connect(connection);
  return (mutations[0] as any).entities[0].entity;
}

describe('toEntityName', () => {
  it('passes through slugs that are already valid', () => {
    expect(toEntityName('oxp-backend')).toBe('oxp-backend');
    expect(toEntityName('daarwyn_data.sync')).toBe('daarwyn_data.sync');
  });

  it('replaces characters Backstage does not permit', () => {
    expect(toEntityName('team/service')).toBe('team-service');
    expect(toEntityName('café-api')).toBe('caf-api');
  });

  it('trims to the 63 character limit', () => {
    expect(toEntityName('a'.repeat(80))).toHaveLength(63);
  });

  it('strips leading and trailing non-alphanumerics', () => {
    expect(toEntityName('--edge--')).toBe('edge');
  });

  it('refuses a slug that cannot yield a valid name', () => {
    expect(() => toEntityName('---')).toThrow('no valid entity name');
  });
});

describe('BitbucketRepositoryEntityProvider', () => {
  it('names itself stably, per workspace', () => {
    const { provider } = harness([]);
    expect(provider.getProviderName()).toBe('bitbucket-repositories:demandai');
  });

  it('applies a full mutation so removed repositories disappear', async () => {
    const { provider, connection, mutations } = harness([
      repository({ slug: 'a' }),
      repository({ slug: 'b' }),
    ]);

    await provider.connect(connection);

    expect(mutations).toHaveLength(1);
    expect(mutations[0].type).toBe('full');
    expect((mutations[0] as any).entities).toHaveLength(2);
  });

  it('tags every entity with a location key scoped to this provider', async () => {
    const { provider, connection, mutations } = harness([repository()]);

    await provider.connect(connection);

    expect((mutations[0] as any).entities[0].locationKey).toBe(
      'bitbucket-repositories:demandai',
    );
  });

  it('produces a Component with the agreed placeholder spec', async () => {
    const entity = await entityFor();

    expect(entity.kind).toBe('Component');
    expect(entity.spec).toEqual({
      type: 'service',
      lifecycle: 'unknown',
      owner: 'group:default/unowned',
    });
  });

  it('carries the identifiers needed to fetch this repository again later', async () => {
    const entity = await entityFor({
      projectKey: 'OXP',
      defaultBranch: 'develop',
    });

    expect(entity.metadata.annotations[ANNOTATION_WORKSPACE]).toBe('demandai');
    expect(entity.metadata.annotations[ANNOTATION_SLUG]).toBe('oxp-backend');
    expect(entity.metadata.annotations[ANNOTATION_PROJECT_KEY]).toBe('OXP');
    expect(entity.metadata.annotations[ANNOTATION_DEFAULT_BRANCH]).toBe(
      'develop',
    );
  });

  it('links back to the source on the default branch', async () => {
    const entity = await entityFor({ defaultBranch: 'main' });

    expect(entity.metadata.annotations['backstage.io/source-location']).toBe(
      'url:https://bitbucket.org/demandai/oxp-backend/src/main/',
    );
  });

  it('omits branch annotations when Bitbucket reports no default branch', async () => {
    const entity = await entityFor({ defaultBranch: undefined });

    expect(
      entity.metadata.annotations[ANNOTATION_DEFAULT_BRANCH],
    ).toBeUndefined();
    expect(
      entity.metadata.annotations['backstage.io/source-location'],
    ).toBeUndefined();
  });

  it('uses the repository name as the display title', async () => {
    const entity = await entityFor({ name: 'OXP Backend' });

    expect(entity.metadata.name).toBe('oxp-backend');
    expect(entity.metadata.title).toBe('OXP Backend');
  });

  it('tags by language when Bitbucket detected one', async () => {
    await expect(entityFor({ language: 'TypeScript' })).resolves.toMatchObject({
      metadata: { tags: ['typescript'] },
    });
  });

  it('omits tags entirely for the 94% with no detected language', async () => {
    const entity = await entityFor({ language: undefined });

    expect(entity.metadata.tags).toBeUndefined();
  });

  it('omits description rather than emitting an empty one', async () => {
    const entity = await entityFor({ description: undefined });

    expect('description' in entity.metadata).toBe(false);
  });

  it('refuses to apply anything before it is connected', async () => {
    const { provider } = harness([repository()]);

    await expect(provider.refresh()).rejects.toThrow('not connected');
  });

  it('survives an ingestion failure instead of killing the scheduled task', async () => {
    const failing = stubBitbucketClient({
      listRepositories: async () => {
        throw new Error('bitbucket is down');
      },
    });
    const provider = new BitbucketRepositoryEntityProvider({
      workspace: 'demandai',
      client: failing,
      logger: mockServices.logger.mock(),
      taskRunner: {
        run: async task => {
          await task.fn(new AbortController().signal);
        },
      },
    });

    await expect(
      provider.connect({
        applyMutation: async () => {},
        refresh: async () => {},
      }),
    ).resolves.toBeUndefined();
  });
});

describe('BitbucketRepositoryEntityProvider.fromConfig', () => {
  const integrations = {
    integrations: {
      bitbucketCloud: [{ username: 'u', appPassword: 'p' }],
    },
  };
  const deps = () => ({
    logger: mockServices.logger.mock(),
    scheduler: mockServices.scheduler.mock(),
  });

  it('builds one provider per configured workspace', () => {
    const config = new ConfigReader({
      ...integrations,
      fleet: { bitbucket: { workspaces: ['demandai', 'other'] } },
    });

    const providers = BitbucketRepositoryEntityProvider.fromConfig(
      config,
      deps(),
    );

    expect(providers.map(p => p.getProviderName())).toEqual([
      'bitbucket-repositories:demandai',
      'bitbucket-repositories:other',
    ]);
  });

  it('builds nothing, and warns, when no workspaces are configured', () => {
    const options = deps();
    const providers = BitbucketRepositoryEntityProvider.fromConfig(
      new ConfigReader(integrations),
      options,
    );

    expect(providers).toEqual([]);
    expect(options.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No fleet.bitbucket.workspaces configured'),
    );
  });

  it('fails loudly when workspaces are configured without credentials', () => {
    // Backstage always supplies a default bitbucket.org integration entry, so
    // the reachable failure is missing credentials rather than a missing entry.
    const config = new ConfigReader({
      fleet: { bitbucket: { workspaces: ['demandai'] } },
    });

    expect(() =>
      BitbucketRepositoryEntityProvider.fromConfig(config, deps()),
    ).toThrow(/no usable credentials/);
  });
});
