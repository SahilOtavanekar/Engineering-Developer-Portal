import type { BitbucketCommit, BitbucketRepository } from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { RepositoryStore } from '../database/RepositoryStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { RegisterOwnershipResolver } from './RegisterOwnershipResolver';
import { EMPTY_OWNERSHIP_REGISTER } from './ownershipRegister';
import { OWNERSHIP_SOURCE_REGISTER } from './types';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const SINCE = new Date('2026-05-28T12:00:00.000Z');
const WINDOW_DAYS = 90;
const DAY = 86_400_000;

const BRIJESH = { name: 'Brijesh Gupta', email: 'brijesh.gupta@demandai.co' };
const SANJAY = { name: 'Sanjay Kumar', email: 'sanjay.kumar@demandai.co' };

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

function commitsBy(email: string, n: number): BitbucketCommit[] {
  return Array.from({ length: n }, (_, i) => ({
    hash: `${email}-${i}`,
    committedAt: new Date(NOW.getTime() - i * DAY).toISOString(),
    authorName: email,
    authorEmail: email,
    parentCount: 1,
  }));
}

function registerOf(repositories: Record<string, string[]>) {
  return {
    people: new Map([
      ['brijesh', BRIJESH],
      ['sanjay', SANJAY],
    ]),
    repositories: new Map(Object.entries(repositories)),
  };
}

describe('RegisterOwnershipResolver', () => {
  let db: FleetTestDatabase;
  let commits: CommitStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  const build = (register = registerOf({ 'oxp-backend': ['brijesh'] })) =>
    new RegisterOwnershipResolver({ register, repositories, commits });

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

  it('reports the register as its source', () => {
    expect(build().source).toBe(OWNERSHIP_SOURCE_REGISTER);
  });

  it('proposes the registered owner', async () => {
    const proposal = await build().resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed).toMatchObject(BRIJESH);
  });

  it('proposes the owner even with no commits at all', async () => {
    // Accountability does not lapse because somebody stopped typing, and the
    // register is not an inference from activity.
    const proposal = await build().resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.email).toBe(BRIJESH.email);
    expect(proposal.proposed?.commits).toBe(0);
  });

  it('keeps every registered owner as a ranked candidate, in register order', async () => {
    const proposal = await build(
      registerOf({ 'oxp-backend': ['sanjay', 'brijesh'] }),
    ).resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.candidates.map(c => c.email)).toEqual([
      SANJAY.email,
      BRIJESH.email,
    ]);
    expect(proposal.proposed?.email).toBe(SANJAY.email);
  });

  it('does not let commit counts reorder the register', async () => {
    // The whole point of the register is that it outranks activity. If the
    // busiest committer could float to rank 1 this would just be the commit
    // history resolver wearing a different name.
    await commits.insertMany(repositoryId, commitsBy(BRIJESH.email, 40));

    const proposal = await build(
      registerOf({ 'oxp-backend': ['sanjay', 'brijesh'] }),
    ).resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.email).toBe(SANJAY.email);
  });

  it('reports commit counts alongside a confirmed owner', async () => {
    await commits.insertMany(repositoryId, commitsBy(BRIJESH.email, 12));

    const proposal = await build().resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.proposed?.commits).toBe(12);
    expect(proposal.windowCommits).toBe(12);
  });

  it('proposes nobody for a repository the register does not mention', async () => {
    // Which is what lets the composite resolver fall through to the derived
    // sources for the repositories nobody has written down yet.
    const proposal = await build(registerOf({ crm: ['brijesh'] })).resolve(
      repositoryId,
      SINCE,
      WINDOW_DAYS,
    );

    expect(proposal.candidates).toEqual([]);
    expect(proposal.proposed).toBeUndefined();
  });

  it('proposes nobody when there is no register at all', async () => {
    const resolver = new RegisterOwnershipResolver({
      register: EMPTY_OWNERSHIP_REGISTER,
      repositories,
      commits,
    });

    const proposal = await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(proposal.candidates).toEqual([]);
  });

  it('costs no queries when the register is empty', async () => {
    // 95 repositories a pass; an unconfigured register must not turn into 190
    // pointless database round trips.
    const findById = jest.spyOn(repositories, 'findById');
    const resolver = new RegisterOwnershipResolver({
      register: EMPTY_OWNERSHIP_REGISTER,
      repositories,
      commits,
    });

    await resolver.resolve(repositoryId, SINCE, WINDOW_DAYS);

    expect(findById).not.toHaveBeenCalled();
    findById.mockRestore();
  });

  it('proposes nobody for a repository id that does not exist', async () => {
    const proposal = await build().resolve(-1, SINCE, WINDOW_DAYS);

    expect(proposal.candidates).toEqual([]);
  });
});
