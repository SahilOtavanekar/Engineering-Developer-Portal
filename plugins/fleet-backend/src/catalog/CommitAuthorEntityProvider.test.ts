import { mockServices } from '@backstage/backend-test-utils';
import type {
  EntityProviderConnection,
  EntityProviderMutation,
} from '@backstage/plugin-catalog-node';
import type { OwnershipStore } from '../database/OwnershipStore';
import {
  ANNOTATION_AUTHOR_EMAIL,
  ANNOTATION_IDENTITY_SOURCE,
  CommitAuthorEntityProvider,
  TAG_DERIVED_IDENTITY,
} from './CommitAuthorEntityProvider';
import { toUserEntityName, toUserEntityRef } from './userEntityName';

type Author = { name?: string; email: string; accountId?: string };

function harness(authors: Author[] | Error) {
  const mutations: EntityProviderMutation[] = [];
  const connection: EntityProviderConnection = {
    applyMutation: async mutation => {
      mutations.push(mutation);
    },
    refresh: async () => {},
  };

  const ownership = {
    candidateAuthors: async () => {
      if (authors instanceof Error) throw authors;
      return authors;
    },
  } as unknown as OwnershipStore;

  const provider = new CommitAuthorEntityProvider({
    workspace: 'demandai',
    ownership,
    logger: mockServices.logger.mock(),
    taskRunner: {
      run: async task => {
        await task.fn(new AbortController().signal);
      },
    },
  });

  return { provider, connection, mutations };
}

async function entitiesFor(authors: Author[]) {
  const { provider, connection, mutations } = harness(authors);
  await provider.connect(connection);
  return (mutations[0] as any).entities.map((e: any) => e.entity);
}

describe('toUserEntityName', () => {
  it('takes the local part of the address', () => {
    expect(toUserEntityName('brijesh.gupta@demandai.co')).toBe('brijesh.gupta');
  });

  it('lowercases, so one person cannot become two entities', () => {
    expect(toUserEntityName('Brijesh.Gupta@demandai.co')).toBe('brijesh.gupta');
  });

  it('replaces characters Backstage does not permit', () => {
    expect(toUserEntityName("o'brien+ci@demandai.co")).toBe('o-brien-ci');
  });

  it('trims to the 63 character limit', () => {
    expect(toUserEntityName(`${'a'.repeat(80)}@x.co`)).toHaveLength(63);
  });

  it('returns undefined rather than throwing on an unusable address', () => {
    // One bad address must not stop everyone else being registered.
    expect(toUserEntityName('@@@')).toBeUndefined();
    expect(toUserEntityName('')).toBeUndefined();
  });

  it('builds a ref only when there is a name to build it from', () => {
    expect(toUserEntityRef('ada@demandai.co')).toBe('user:default/ada');
    expect(toUserEntityRef('@@@')).toBeUndefined();
  });
});

describe('CommitAuthorEntityProvider', () => {
  it('registers a User per candidate author', async () => {
    const entities = await entitiesFor([
      { name: 'Brijesh Gupta', email: 'brijesh.gupta@demandai.co' },
      { name: 'Ada Lovelace', email: 'ada@demandai.co' },
    ]);

    expect(entities.map((e: any) => e.metadata.name)).toEqual([
      'brijesh.gupta',
      'ada',
    ]);
    expect(entities[0].kind).toBe('User');
  });

  it('carries the display name and email onto the profile', async () => {
    const [entity] = await entitiesFor([
      { name: 'Brijesh Gupta', email: 'brijesh.gupta@demandai.co' },
    ]);

    expect(entity.spec.profile).toEqual({
      displayName: 'Brijesh Gupta',
      email: 'brijesh.gupta@demandai.co',
    });
    expect(entity.metadata.title).toBe('Brijesh Gupta');
    expect(entity.metadata.annotations[ANNOTATION_AUTHOR_EMAIL]).toBe(
      'brijesh.gupta@demandai.co',
    );
  });

  it('marks these identities as derived, not supplied by a directory', async () => {
    const [entity] = await entitiesFor([{ email: 'ada@demandai.co' }]);

    expect(entity.metadata.tags).toEqual([TAG_DERIVED_IDENTITY]);
    expect(entity.metadata.annotations[ANNOTATION_IDENTITY_SOURCE]).toBe(
      'commit-history',
    );
    expect(entity.metadata.description).toMatch(/not from a directory/i);
  });

  it('claims no group membership, because there is no team data', async () => {
    // Inventing one would put a fiction into the org chart.
    const [entity] = await entitiesFor([{ email: 'ada@demandai.co' }]);

    expect(entity.spec.memberOf).toEqual([]);
  });

  it('survives an author with no display name', async () => {
    const [entity] = await entitiesFor([{ email: 'ada@demandai.co' }]);

    expect(entity.spec.profile).toEqual({ email: 'ada@demandai.co' });
    expect(entity.metadata.title).toBeUndefined();
  });

  it('skips an address that cannot become an entity name', async () => {
    const entities = await entitiesFor([
      { email: '@@@' },
      { email: 'ada@demandai.co' },
    ]);

    expect(entities.map((e: any) => e.metadata.name)).toEqual(['ada']);
  });

  it('keeps the first of two addresses that reduce to one name', async () => {
    // Busiest first from the store, so the survivor is the larger contributor
    // rather than whichever the database happened to return last.
    const entities = await entitiesFor([
      { name: 'Ada at work', email: 'ada@demandai.co' },
      { name: 'Ada at home', email: 'ada@personal.example' },
    ]);

    expect(entities).toHaveLength(1);
    expect(entities[0].metadata.title).toBe('Ada at work');
  });

  it('replaces the whole set on each pass, so departures disappear', async () => {
    const { provider, connection, mutations } = harness([
      { email: 'ada@demandai.co' },
    ]);
    await provider.connect(connection);

    expect(mutations[0].type).toBe('full');
  });

  it('applies an empty set rather than failing when nobody is a candidate', async () => {
    const { provider, connection, mutations } = harness([]);

    await provider.connect(connection);

    expect((mutations[0] as any).entities).toEqual([]);
  });

  it('does not kill its scheduled task when the database is unreadable', async () => {
    // Throwing out of the task would stop it running ever again.
    const { provider, connection, mutations } = harness(
      new Error('relation "ownership_candidate" does not exist'),
    );

    await expect(provider.connect(connection)).resolves.toBeUndefined();
    expect(mutations).toHaveLength(0);
  });

  it('names its provider per workspace', () => {
    const { provider } = harness([]);

    expect(provider.getProviderName()).toBe('fleet-commit-authors:demandai');
  });

  it('refuses to refresh before it is connected', async () => {
    const { provider } = harness([]);

    await expect(provider.refresh()).rejects.toThrow(/not connected/);
  });
});
