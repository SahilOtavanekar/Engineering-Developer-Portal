import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type {
  BitbucketCommit,
  BitbucketRepository,
  BitbucketRepositoryPermission,
} from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { RepositoryStore } from '../database/RepositoryStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PermissionOwnershipResolver } from './PermissionOwnershipResolver';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const SINCE = new Date('2026-05-27T12:00:00.000Z');
const WINDOW_DAYS = 90;
const DAY = 86_400_000;

function repository(slug = 'oxp-backend'): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug,
    name: slug,
    url: `https://bitbucket.org/demandai/${slug}`,
    isPrivate: true,
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
  };
}

function commitsBy(
  name: string,
  email: string,
  n: number,
  offset = 0,
): BitbucketCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `${email}-${offset + i}`,
    committedAt: new Date(NOW.getTime() - (offset + i) * DAY).toISOString(),
    authorName: name,
    authorEmail: email,
    parentCount: 1,
  }));
}

function permission(
  displayName: string,
  level: string,
): BitbucketRepositoryPermission {
  return {
    permission: level,
    displayName,
    accountId: `acc-${displayName.toLowerCase().replace(/\W+/g, '-')}`,
  };
}

describe('PermissionOwnershipResolver', () => {
  let db: FleetTestDatabase;
  let commits: CommitStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  async function build(
    permissions: BitbucketRepositoryPermission[],
    slug = 'oxp-backend',
  ) {
    const client = new FakeBitbucketClient([repository(slug)]).withPermissions(
      'demandai',
      slug,
      permissions,
    );
    const resolver = new PermissionOwnershipResolver({
      client,
      commits,
      repositories,
    });
    await resolver.prepare('demandai');
    return { resolver, client };
  }

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    commits = new CommitStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('commit').delete();
    await db.client('repository').delete();
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    repositoryId = stored!.id;
  });

  it('names its source so a permission is never mistaken for an inference', async () => {
    const { resolver } = await build([]);

    expect(resolver.source).toBe('repository-admin');
  });

  it('proposes a sole admin', async () => {
    await commits.insertMany(
      repositoryId,
      commitsBy('Sreenivas Dasam', 'sreenivas.dasam@demandai.co', 4),
    );
    const { resolver } = await build([
      permission('Sreenivas Dasam', 'admin'),
      permission('Subham Jain', 'write'),
    ]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed).toMatchObject({
      name: 'Sreenivas Dasam',
      email: 'sreenivas.dasam@demandai.co',
    });
    expect(proposal.candidates).toHaveLength(1);
  });

  it('proposes a sole admin who has not committed at all', async () => {
    // Accountability does not lapse because somebody stopped typing.
    const { resolver } = await build([permission('Sreenivas Dasam', 'admin')]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.name).toBe('Sreenivas Dasam');
    expect(proposal.proposed?.commits).toBe(0);
  });

  it('ignores write and read permissions entirely', async () => {
    const { resolver } = await build([
      permission('Subham Jain', 'write'),
      permission('Gurudutt .', 'read'),
    ]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.candidates).toEqual([]);
    expect(proposal.proposed).toBeUndefined();
  });

  it('breaks a tie between admins on commit count', async () => {
    // 10 of 95 repositories have more than one admin. The accountable person
    // who is also doing the work is the better guess.
    await commits.insertMany(repositoryId, [
      ...commitsBy('Avinash More', 'avinash.more@demandai.co', 20),
      ...commitsBy('Sreenivas Dasam', 'sreenivas.dasam@demandai.co', 3, 40),
    ]);
    const { resolver } = await build([
      permission('Sreenivas Dasam', 'admin'),
      permission('Avinash More', 'admin'),
    ]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.name).toBe('Avinash More');
    expect(proposal.candidates.map(c => c.name)).toEqual([
      'Avinash More',
      'Sreenivas Dasam',
    ]);
  });

  it('proposes nobody when several admins have all been idle', async () => {
    // Nothing to choose between them, and picking one would be a coin toss.
    const { resolver } = await build([
      permission('Sreenivas Dasam', 'admin'),
      permission('Avinash More', 'admin'),
    ]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed).toBeUndefined();
    expect(proposal.candidates).toHaveLength(2);
  });

  it('proposes nothing at all when no admin is configured', async () => {
    // 17 of 95 repositories. Not "unowned" -- Bitbucket was never told, and the
    // composite resolver falls back to commit history for these.
    const { resolver } = await build([permission('Subham Jain', 'write')]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal).toMatchObject({ candidates: [], windowDays: 90 });
    expect(proposal.proposed).toBeUndefined();
  });

  it('joins an admin to their email through commit history', async () => {
    // Permissions carry no email and /users/{id} is 403 for this credential.
    await commits.insertMany(
      repositoryId,
      commitsBy('Gurudutt .', 'gurudutt@demandai.co', 5),
    );
    const { resolver } = await build([permission('Gurudutt .', 'admin')]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.email).toBe('gurudutt@demandai.co');
  });

  it('still proposes an admin who never committed, without an email', async () => {
    // Two of this estate's 16 admins are in exactly this position. A name with
    // no address is better than silence; the catalog names them from the
    // display name instead.
    const { resolver } = await build([
      permission('Amey Sunil khurdekar', 'admin'),
    ]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed).toMatchObject({
      name: 'Amey Sunil khurdekar',
      email: undefined,
    });
  });

  it('keeps the account id, which survives a rename', async () => {
    const { resolver } = await build([permission('Sreenivas Dasam', 'admin')]);

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.accountId).toBe('acc-sreenivas-dasam');
  });

  it('spends one request per repository, and none breaking a lone tie', async () => {
    const { resolver, client } = await build([
      permission('Sreenivas Dasam', 'admin'),
    ]);

    await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(client.requestsFor('listRepositoryPermissions')).toBe(1);
    // Commit ranking is only needed to separate multiple admins.
    expect(client.requestsFor('listCommits')).toBe(0);
  });

  it('reports the window it was given', async () => {
    const { resolver } = await build([permission('Sreenivas Dasam', 'admin')]);

    const proposal = await resolver.resolve(repositoryId, SINCE, 30);

    expect(proposal.windowDays).toBe(30);
  });

  it('returns nothing for a repository it cannot find', async () => {
    const { resolver } = await build([permission('Sreenivas Dasam', 'admin')]);

    await expect(
      resolver.resolve(999_999, SINCE, WINDOW_DAYS),
    ).resolves.toMatchObject({ candidates: [] });
  });
});
