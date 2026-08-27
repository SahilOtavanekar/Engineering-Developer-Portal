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
  ANNOTATION_OWNERSHIP_EVIDENCE,
  ANNOTATION_OWNERSHIP_SOURCE,
  ANNOTATION_PROJECT_KEY,
  ANNOTATION_SLUG,
  ANNOTATION_WORKSPACE,
  BitbucketRepositoryEntityProvider,
  TAG_CONFIRMED_OWNER,
  TAG_DIRECT_COMMITS,
  TAG_UNCONFIRMED_OWNER,
  type ClassificationSource,
  type BranchPolicySource,
  type ProposedOwnerSource,
} from './BitbucketRepositoryEntityProvider';
import { OWNERSHIP_SOURCE_REGISTER } from '../ownership/types';
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

/** A proposed owner for one slug, shaped like the store returns it. */
function ownerSource(
  bySlug: Record<
    string,
    | { name?: string; email?: string; commits?: number; source?: string }
    | undefined
  >,
): ProposedOwnerSource {
  return {
    proposedForWorkspace: async () =>
      new Map(
        Object.entries(bySlug)
          .filter(([, value]) => value !== undefined)
          .map(([slug, value]) => [
            slug,
            {
              rank: 1,
              isProposed: true,
              name: value!.name,
              email: value!.email,
              accountId: undefined,
              commits: value!.commits ?? 34,
              windowCommits: 41,
              windowDays: 90,
              source: value!.source ?? 'commit-history',
              resolvedAt: new Date('2026-08-24T12:00:00.000Z'),
            },
          ]),
      ),
  };
}

function classificationSource(
  bySlug: Record<string, { type: string; lifecycle: string }>,
): ClassificationSource {
  return {
    classificationForWorkspace: async () => new Map(Object.entries(bySlug)),
  };
}

/** Captures whatever the provider applies, and runs scheduled work inline. */
function harness(
  repositories: BitbucketRepository[],
  owners?: ProposedOwnerSource,
  classifications?: ClassificationSource,
  branchPolicy?: BranchPolicySource,
) {
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
    owners,
    classifications,
    branchPolicy,
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

describe('proposed owners on the entity', () => {
  async function entityWithOwner(
    owner: { name?: string; email?: string; commits?: number } | undefined,
  ) {
    const { provider, connection, mutations } = harness(
      [repository()],
      ownerSource({ 'oxp-backend': owner }),
    );
    await provider.connect(connection);
    return (mutations[0] as any).entities[0].entity;
  }

  it('owns the component with the proposed person', async () => {
    const entity = await entityWithOwner({
      name: 'Brijesh Gupta',
      email: 'brijesh.gupta@demandai.co',
    });

    expect(entity.spec.owner).toBe('user:default/brijesh.gupta');
  });

  it('tags the owner as unconfirmed, because the column cannot say so', async () => {
    const entity = await entityWithOwner({
      name: 'Brijesh Gupta',
      email: 'brijesh.gupta@demandai.co',
    });

    expect(entity.metadata.tags).toContain(TAG_UNCONFIRMED_OWNER);
  });

  it('records the evidence alongside the name', async () => {
    const entity = await entityWithOwner({
      name: 'Brijesh Gupta',
      email: 'brijesh.gupta@demandai.co',
      commits: 34,
    });

    expect(entity.metadata.annotations[ANNOTATION_OWNERSHIP_SOURCE]).toBe(
      'commit-history',
    );
    expect(entity.metadata.annotations[ANNOTATION_OWNERSHIP_EVIDENCE]).toBe(
      '34 of 41 commits in 90 days',
    );
  });

  it('keeps the placeholder owner when nobody was proposed', async () => {
    const entity = await entityWithOwner(undefined);

    expect(entity.spec.owner).toBe('group:default/unowned');
    expect(entity.metadata.tags ?? []).not.toContain(TAG_UNCONFIRMED_OWNER);
    expect(
      entity.metadata.annotations[ANNOTATION_OWNERSHIP_SOURCE],
    ).toBeUndefined();
  });

  it('keeps the placeholder when the address cannot become an entity name', async () => {
    // A ref that does not resolve renders as a broken link, which reads as a
    // defect rather than as the gap it actually is.
    const entity = await entityWithOwner({ name: 'Nobody', email: '@@@' });

    expect(entity.spec.owner).toBe('group:default/unowned');
  });

  it('keeps the placeholder when a candidate has no address at all', async () => {
    const entity = await entityWithOwner({ name: 'Anonymous' });

    expect(entity.spec.owner).toBe('group:default/unowned');
  });

  it('keeps the language tag alongside the ownership tag', async () => {
    const { provider, connection, mutations } = harness(
      [repository({ language: 'TypeScript' })],
      ownerSource({ 'oxp-backend': { email: 'ada@demandai.co' } }),
    );
    await provider.connect(connection);
    const entity = (mutations[0] as any).entities[0].entity;

    expect(entity.metadata.tags).toEqual(['typescript', TAG_UNCONFIRMED_OWNER]);
  });

  it('registers the estate anyway when ownership cannot be read', async () => {
    // Ownership is a derived hint. Losing it must degrade the catalog to
    // placeholder owners, not stop 95 repositories being registered.
    const broken: ProposedOwnerSource = {
      proposedForWorkspace: async () => {
        throw new Error('relation "ownership_candidate" does not exist');
      },
    };
    const { provider, connection, mutations } = harness([repository()], broken);

    await provider.connect(connection);

    const entity = (mutations[0] as any).entities[0].entity;
    expect(entity.spec.owner).toBe('group:default/unowned');
  });

  it('leaves every other repository unowned when only one has a proposal', async () => {
    const { provider, connection, mutations } = harness(
      [repository(), repository({ slug: 'crm', name: 'CRM' })],
      ownerSource({ 'oxp-backend': { email: 'ada@demandai.co' } }),
    );
    await provider.connect(connection);

    const owners = (mutations[0] as any).entities.map(
      (e: any) => e.entity.spec.owner,
    );
    expect(owners).toEqual(['user:default/ada', 'group:default/unowned']);
  });
});

describe('derived type and lifecycle', () => {
  async function entityWith(classification?: {
    type: string;
    lifecycle: string;
  }) {
    const { provider, connection, mutations } = harness(
      [repository()],
      undefined,
      classification
        ? classificationSource({ 'oxp-backend': classification })
        : undefined,
    );
    await provider.connect(connection);
    return (mutations[0] as any).entities[0].entity;
  }

  it('uses the derived type and lifecycle', async () => {
    const entity = await entityWith({
      type: 'website',
      lifecycle: 'production',
    });

    expect(entity.spec.type).toBe('website');
    expect(entity.spec.lifecycle).toBe('production');
  });

  it('passes through an unknown classification rather than overriding it', async () => {
    // "Looked and found no evidence" is a real answer, not a missing one.
    const entity = await entityWith({ type: 'unknown', lifecycle: 'unknown' });

    expect(entity.spec.type).toBe('unknown');
    expect(entity.spec.lifecycle).toBe('unknown');
  });

  it('keeps the original placeholders when nothing has classified it yet', async () => {
    const entity = await entityWith(undefined);

    expect(entity.spec.type).toBe('service');
    expect(entity.spec.lifecycle).toBe('unknown');
  });

  it('keeps the placeholders for a repository missing from the map', async () => {
    const { provider, connection, mutations } = harness(
      [repository(), repository({ slug: 'crm', name: 'CRM' })],
      undefined,
      classificationSource({
        'oxp-backend': { type: 'service', lifecycle: 'production' },
      }),
    );
    await provider.connect(connection);

    // Keyed by name rather than by index: nothing guarantees the provider
    // preserves the order repositories were listed in.
    const byName = new Map<string, any>(
      (mutations[0] as any).entities.map((e: any) => [
        e.entity.metadata.name,
        e.entity.spec,
      ]),
    );
    expect(byName.get('oxp-backend')).toMatchObject({
      type: 'service',
      lifecycle: 'production',
    });
    expect(byName.get('crm')).toMatchObject({
      type: 'service',
      lifecycle: 'unknown',
    });
  });

  it('registers the estate anyway when classifications cannot be read', async () => {
    const broken: ClassificationSource = {
      classificationForWorkspace: async () => {
        throw new Error('column "derived_type" does not exist');
      },
    };
    const { provider, connection, mutations } = harness(
      [repository()],
      undefined,
      broken,
    );

    await provider.connect(connection);

    const entity = (mutations[0] as any).entities[0].entity;
    expect(entity.spec).toMatchObject({
      type: 'service',
      lifecycle: 'unknown',
    });
  });

  it('carries an owner and a classification together', async () => {
    const { provider, connection, mutations } = harness(
      [repository()],
      ownerSource({ 'oxp-backend': { email: 'ada@demandai.co' } }),
      classificationSource({
        'oxp-backend': { type: 'website', lifecycle: 'production' },
      }),
    );
    await provider.connect(connection);

    const entity = (mutations[0] as any).entities[0].entity;
    expect(entity.spec).toEqual({
      type: 'website',
      lifecycle: 'production',
      owner: 'user:default/ada',
    });
  });
});

describe('ownership evidence', () => {
  async function evidenceFor(owner: {
    name?: string;
    email?: string;
    commits?: number;
    source?: string;
  }) {
    const { provider, connection, mutations } = harness(
      [repository()],
      ownerSource({ 'oxp-backend': owner }),
    );
    await provider.connect(connection);
    return (mutations[0] as any).entities[0].entity.metadata.annotations[
      ANNOTATION_OWNERSHIP_EVIDENCE
    ];
  }

  it('leads with the permission when that is what decided it', async () => {
    // "9 of 208 commits" would read as an absurd justification for a claim
    // that does not rest on commits at all.
    const evidence = await evidenceFor({
      email: 'avinash.more@demandai.co',
      commits: 9,
      source: 'repository-admin',
    });

    expect(evidence).toBe(
      'Repository admin in Bitbucket, and 9 of 41 commits in 90 days',
    );
  });

  it('says so plainly when an admin has not committed at all', async () => {
    const evidence = await evidenceFor({
      email: 'makarand.prabhu@demandai.co',
      commits: 0,
      source: 'repository-admin',
    });

    expect(evidence).toBe(
      'Repository admin in Bitbucket; no commits in the window',
    );
  });

  it('gives the commit share alone when that is the whole argument', async () => {
    const evidence = await evidenceFor({
      email: 'brijesh.gupta@demandai.co',
      commits: 34,
      source: 'commit-history',
    });

    expect(evidence).toBe('34 of 41 commits in 90 days');
  });

  it('says a person confirmed it when the register did', async () => {
    // Leading with a commit share here would invite the reader to re-derive a
    // conclusion that does not rest on commits at all.
    const evidence = await evidenceFor({
      email: 'brijesh.gupta@demandai.co',
      commits: 34,
      source: OWNERSHIP_SOURCE_REGISTER,
    });

    expect(evidence).toBe(
      'Confirmed in the ownership register, and 34 of 41 commits in 90 days',
    );
  });

  it('confirms without mentioning commits when there are none', async () => {
    const evidence = await evidenceFor({
      email: 'sunil.chandrabhankadam@demandai.co',
      commits: 0,
      source: OWNERSHIP_SOURCE_REGISTER,
    });

    expect(evidence).toBe('Confirmed in the ownership register');
  });
});

describe('direct commits to the default branch', () => {
  const policySource = (
    bySlug: Record<string, { direct: number; directMerge: number }>,
  ) => ({
    branchPolicyForWorkspace: async () => new Map(Object.entries(bySlug)),
  });

  async function tagsFor(source: any) {
    const { provider, connection, mutations } = harness(
      [repository()],
      undefined,
      undefined,
      source,
    );
    await provider.connect(connection);
    return ((mutations[0] as any).entities[0].entity.metadata.tags ??
      []) as string[];
  }

  it('tags a repository with a direct commit', async () => {
    const tags = await tagsFor(
      policySource({ 'oxp-backend': { direct: 8, directMerge: 0 } }),
    );

    expect(tags).toContain(TAG_DIRECT_COMMITS);
  });

  it('tags a repository whose only direct arrivals were merges', async () => {
    // 600 merge commits against 324 merged pull requests estate-wide, so a
    // merge with no PR behind it is not an edge case.
    const tags = await tagsFor(
      policySource({ 'oxp-backend': { direct: 0, directMerge: 3 } }),
    );

    expect(tags).toContain(TAG_DIRECT_COMMITS);
  });

  it('leaves a fully pull-request-driven repository untagged', async () => {
    const tags = await tagsFor(
      policySource({ 'oxp-backend': { direct: 0, directMerge: 0 } }),
    );

    expect(tags).not.toContain(TAG_DIRECT_COMMITS);
  });

  it('leaves an unclassified repository untagged', async () => {
    // Absence of evidence is not evidence of a bypassed review.
    const tags = await tagsFor(policySource({}));

    expect(tags).not.toContain(TAG_DIRECT_COMMITS);
  });

  it('registers the estate anyway when the policy source throws', async () => {
    const tags = await tagsFor({
      branchPolicyForWorkspace: async () => {
        throw new Error('fleet database unavailable');
      },
    });

    expect(tags).not.toContain(TAG_DIRECT_COMMITS);
  });
});

describe('confirmed versus proposed ownership', () => {
  async function tagsFor(source: string) {
    const { provider, connection, mutations } = harness(
      [repository()],
      ownerSource({
        'oxp-backend': { email: 'brijesh.gupta@demandai.co', source },
      }),
    );
    await provider.connect(connection);
    return ((mutations[0] as any).entities[0].entity.metadata.tags ??
      []) as string[];
  }

  it('does not caveat an owner somebody actually confirmed', async () => {
    // The register is the only source that is not an inference. Tagging its
    // answers 'unconfirmed' would make the caveat meaningless everywhere.
    const tags = await tagsFor(OWNERSHIP_SOURCE_REGISTER);

    expect(tags).toContain(TAG_CONFIRMED_OWNER);
    expect(tags).not.toContain(TAG_UNCONFIRMED_OWNER);
  });

  it('still caveats an owner inferred from admin permission', async () => {
    // Measured at 76% against the register, so it remains a guess.
    const tags = await tagsFor('repository-admin');

    expect(tags).toContain(TAG_UNCONFIRMED_OWNER);
    expect(tags).not.toContain(TAG_CONFIRMED_OWNER);
  });

  it('still caveats an owner inferred from commit history', async () => {
    const tags = await tagsFor('commit-history');

    expect(tags).toContain(TAG_UNCONFIRMED_OWNER);
    expect(tags).not.toContain(TAG_CONFIRMED_OWNER);
  });

  it('applies neither tag when there is no owner to speak of', async () => {
    const { provider, connection, mutations } = harness(
      [repository()],
      ownerSource({ 'oxp-backend': undefined }),
    );
    await provider.connect(connection);
    const tags = ((mutations[0] as any).entities[0].entity.metadata.tags ??
      []) as string[];

    expect(tags).not.toContain(TAG_CONFIRMED_OWNER);
    expect(tags).not.toContain(TAG_UNCONFIRMED_OWNER);
  });
});
