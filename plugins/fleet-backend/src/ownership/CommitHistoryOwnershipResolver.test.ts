import type { BitbucketCommit, BitbucketRepository } from '../bitbucket/types';
import { CommitStore } from '../database/CommitStore';
import { RepositoryStore } from '../database/RepositoryStore';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { CommitHistoryOwnershipResolver } from './CommitHistoryOwnershipResolver';

const NOW = new Date('2026-08-24T12:00:00.000Z');
const SINCE = new Date('2026-05-26T12:00:00.000Z');
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

/** `n` commits by one author, one per day back from NOW. */
function commitsBy(
  author: { name: string; email: string; accountId?: string },
  n: number,
  options: { offset?: number; parentCount?: number } = {},
): BitbucketCommit[] {
  const offset = options.offset ?? 0;
  return Array.from({ length: n }, (_, i) => ({
    hash: `${author.email}-${offset + i}`,
    committedAt: new Date(NOW.getTime() - (offset + i) * DAY).toISOString(),
    message: 'work',
    authorName: author.name,
    authorEmail: author.email,
    authorAccountId: author.accountId,
    parentCount: options.parentCount ?? 1,
  }));
}

const ADA = { name: 'Ada Lovelace', email: 'ada@demandai.co' };
const ALAN = { name: 'Alan Turing', email: 'alan@demandai.co' };
const GRACE = { name: 'Grace Hopper', email: 'grace@demandai.co' };

describe('CommitHistoryOwnershipResolver', () => {
  let db: FleetTestDatabase;
  let commits: CommitStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  const build = (
    options: Partial<{
      candidateLimit: number;
      minimumShare: number;
      minimumCommits: number;
    }> = {},
  ) => new CommitHistoryOwnershipResolver({ commits, ...options });

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

  it('names the dominant committer', async () => {
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 30),
      ...commitsBy(ALAN, 5, { offset: 40 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed).toMatchObject({
      name: 'Ada Lovelace',
      email: 'ada@demandai.co',
      commits: 30,
    });
    expect(proposal.windowCommits).toBe(35);
  });

  it('reports the runners-up, so the proposal can be judged', async () => {
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 30),
      ...commitsBy(ALAN, 5, { offset: 40 }),
      ...commitsBy(GRACE, 2, { offset: 50 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.candidates.map(c => [c.name, c.commits])).toEqual([
      ['Ada Lovelace', 30],
      ['Alan Turing', 5],
      ['Grace Hopper', 2],
    ]);
  });

  it('proposes nobody when commits are spread evenly', async () => {
    // Three people at a third each. Naming any of them would be a coin toss
    // presented as a finding.
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 10),
      ...commitsBy(ALAN, 10, { offset: 20 }),
      ...commitsBy(GRACE, 10, { offset: 40 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed).toBeUndefined();
    expect(proposal.candidates).toHaveLength(3);
  });

  it('proposes nobody on an exact tie', async () => {
    // Two people at half the commits each clear a 50% threshold. Picking
    // either is a coin toss, so neither is put forward.
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 12),
      ...commitsBy(ALAN, 12, { offset: 20 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed).toBeUndefined();
    expect(proposal.candidates.map(c => c.commits)).toEqual([12, 12]);
  });

  it('names a leader who is ahead by one', async () => {
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 13),
      ...commitsBy(ALAN, 12, { offset: 20 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed?.name).toBe('Ada Lovelace');
  });

  it('refuses to name someone on the strength of a single commit', async () => {
    await commits.insertMany(repositoryId, commitsBy(ADA, 1));

    const proposal = await build().resolve(repositoryId, SINCE);

    // 100% of the window, and still not evidence of ownership.
    expect(proposal.proposed).toBeUndefined();
    expect(proposal.candidates).toHaveLength(1);
  });

  it('proposes nobody for a repository with no commits in the window', async () => {
    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal).toMatchObject({
      candidates: [],
      proposed: undefined,
      windowCommits: 0,
    });
  });

  it('ignores commits older than the window', async () => {
    // Ada owned this a year ago; Alan has owned it since.
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 40, { offset: 300 }),
      ...commitsBy(ALAN, 10),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed?.name).toBe('Alan Turing');
    expect(proposal.windowCommits).toBe(10);
  });

  it('does not count merge commits as authorship', async () => {
    // Whoever presses merge on a busy repository is not its owner.
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 10),
      ...commitsBy(ALAN, 30, { offset: 20, parentCount: 2 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.proposed?.name).toBe('Ada Lovelace');
    expect(proposal.candidates.map(c => c.name)).toEqual(['Ada Lovelace']);
  });

  it('treats one person committing under several names as one person', async () => {
    // Same address, different display name per machine. Splitting these would
    // hide exactly the concentration this is looking for.
    await commits.insertMany(repositoryId, [
      ...commitsBy({ name: 'Ada Lovelace', email: ADA.email }, 6),
      ...commitsBy({ name: 'ada', email: ADA.email }, 6, { offset: 10 }),
      ...commitsBy(ALAN, 4, { offset: 30 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.proposed?.commits).toBe(12);
    // The most recent name they used, not whichever the database returns first.
    expect(proposal.proposed?.name).toBe('Ada Lovelace');
  });

  it('never proposes a Bitbucket bot as an owner', async () => {
    // A pipeline commits more than anyone on some repositories. It writes the
    // code; it does not own it.
    const bot = {
      name: 'Pipelines',
      email: '7gxtj5eqqtgo8iu1yo8il0dejdf5ua@bots.bitbucket.org',
    };
    await commits.insertMany(repositoryId, [
      ...commitsBy(bot, 40),
      ...commitsBy(ADA, 6, { offset: 50 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.candidates.map(c => c.name)).toEqual(['Ada Lovelace']);
    expect(proposal.proposed?.name).toBe('Ada Lovelace');
  });

  it('does not let bot commits dilute a human share', async () => {
    // Ada wrote every line a person wrote. Counting the bot's 40 in the
    // denominator would put her at 13% and propose nobody.
    const bot = { name: 'Pipelines', email: 'x@bots.bitbucket.org' };
    await commits.insertMany(repositoryId, [
      ...commitsBy(bot, 40),
      ...commitsBy(ADA, 6, { offset: 50 }),
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.windowCommits).toBe(6);
    expect(proposal.proposed?.commits).toBe(6);
  });

  it('drops commits that cannot be attributed to anyone', async () => {
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 5),
      {
        hash: 'anonymous',
        committedAt: NOW.toISOString(),
        authorName: undefined,
        authorEmail: undefined,
        parentCount: 1,
      },
    ]);

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.candidates.map(c => c.email)).toEqual(['ada@demandai.co']);
  });

  it('measures share against the whole window, not the candidates kept', async () => {
    // Ada leads the top two but holds only 10 of 40 commits. Measuring her
    // against the kept candidates alone would make her look like a majority.
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 10),
      ...commitsBy(ALAN, 8, { offset: 20 }),
      ...commitsBy(GRACE, 7, { offset: 40 }),
      ...commitsBy({ name: 'D', email: 'd@demandai.co' }, 7, { offset: 50 }),
      ...commitsBy({ name: 'E', email: 'e@demandai.co' }, 8, { offset: 60 }),
    ]);

    const proposal = await build({ candidateLimit: 2 }).resolve(
      repositoryId,
      SINCE,
    );

    expect(proposal.candidates).toHaveLength(2);
    expect(proposal.windowCommits).toBe(40);
    expect(proposal.proposed).toBeUndefined();
  });

  it('honours a configured threshold', async () => {
    await commits.insertMany(repositoryId, [
      ...commitsBy(ADA, 12),
      ...commitsBy(ALAN, 20, { offset: 20 }),
    ]);

    // Alan holds 20 of 32, a 63% share: enough at the default, not at 70%.
    await expect(
      build()
        .resolve(repositoryId, SINCE)
        .then(p => p.proposed?.name),
    ).resolves.toBe('Alan Turing');
    await expect(
      build({ minimumShare: 0.7 })
        .resolve(repositoryId, SINCE)
        .then(p => p.proposed),
    ).resolves.toBeUndefined();
  });

  it('reports the window it measured, so a share can be read honestly', async () => {
    await commits.insertMany(repositoryId, commitsBy(ADA, 5));

    const proposal = await build().resolve(repositoryId, SINCE);

    expect(proposal.windowDays).toBe(90);
  });

  it('names its source', () => {
    expect(build().source).toBe('commit-history');
  });
});
