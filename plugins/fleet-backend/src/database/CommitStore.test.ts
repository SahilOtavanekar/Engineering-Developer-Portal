import { FakeBitbucketClient } from '../bitbucket/FakeBitbucketClient';
import type { BitbucketCommit, BitbucketRepository } from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { CommitStore } from './CommitStore';
import { RepositoryStore } from './RepositoryStore';

const NOW = new Date('2026-08-21T12:00:00.000Z');

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

function commit(overrides: Partial<BitbucketCommit> = {}): BitbucketCommit {
  return {
    hash: 'abc123',
    committedAt: NOW.toISOString(),
    message: 'Fix the thing',
    authorRaw: 'Ada Lovelace <ada@demandai.co>',
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@demandai.co',
    parentCount: 1,
    ...overrides,
  };
}

describe('CommitStore', () => {
  let db: FleetTestDatabase;
  let commits: CommitStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

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

  describe('lifetime', () => {
    it('counts everything, however old', async () => {
      // The window answers "is this maintained now"; this answers "what is
      // this". Both commits here predate any 90-day window.
      await commits.insertMany(repositoryId, [
        commit({
          hash: 'old1',
          committedAt: '2025-08-18T10:00:00.000Z',
          authorEmail: 'ada@demandai.co',
        }),
        commit({
          hash: 'old2',
          committedAt: '2025-08-18T11:00:00.000Z',
          authorEmail: 'alan@demandai.co',
        }),
      ]);

      const lifetime = await commits.lifetime(repositoryId);

      expect(lifetime).toMatchObject({ commits: 2, authors: 2 });
      expect(lifetime.firstCommitAt).toEqual(
        new Date('2025-08-18T10:00:00.000Z'),
      );
      expect(lifetime.lastCommitAt).toEqual(
        new Date('2025-08-18T11:00:00.000Z'),
      );
    });

    it('distinguishes a two-commit scaffold from a real project', async () => {
      // chat-widget has two commits in its entire life and looked identical to
      // an abandoned mature service through a 90-day window.
      await commits.insertMany(repositoryId, [
        commit({ hash: 'a', committedAt: '2025-08-18T10:00:00.000Z' }),
        commit({ hash: 'b', committedAt: '2025-08-18T10:05:00.000Z' }),
      ]);

      await expect(commits.lifetime(repositoryId)).resolves.toMatchObject({
        commits: 2,
      });
    });

    it('excludes merge commits, as every other count does', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'work' }),
        commit({ hash: 'merge', parentCount: 2 }),
      ]);

      await expect(commits.lifetime(repositoryId)).resolves.toMatchObject({
        commits: 1,
      });
    });

    it('reports nothing for a repository with no commits stored', async () => {
      await expect(commits.lifetime(repositoryId)).resolves.toEqual({
        commits: 0,
        authors: 0,
        firstCommitAt: undefined,
        lastCommitAt: undefined,
      });
    });

    it('counts one person committing many times once', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'a', authorEmail: 'ada@demandai.co' }),
        commit({ hash: 'b', authorEmail: 'ada@demandai.co' }),
        commit({ hash: 'c', authorEmail: 'ada@demandai.co' }),
      ]);

      await expect(commits.lifetime(repositoryId)).resolves.toMatchObject({
        commits: 3,
        authors: 1,
      });
    });

    it('does not leak another repository in', async () => {
      await repositories.syncWorkspace(
        'demandai',
        [repository(), repository('crm')],
        NOW,
      );
      const other = await repositories.findByEntityRef('component:default/crm');
      await commits.insertMany(repositoryId, [commit({ hash: 'mine' })]);
      await commits.insertMany(other!.id, [
        commit({ hash: 'theirs1' }),
        commit({ hash: 'theirs2' }),
      ]);

      await expect(commits.lifetime(repositoryId)).resolves.toMatchObject({
        commits: 1,
      });
    });
  });

  it('stores a commit with its author split out', async () => {
    await commits.insertMany(repositoryId, [commit()]);

    const [row] = await db.client('commit').select();

    expect(row).toMatchObject({
      hash: 'abc123',
      author_name: 'Ada Lovelace',
      author_email: 'ada@demandai.co',
      parent_count: 1,
    });
  });

  it('does nothing when given no commits', async () => {
    await expect(commits.insertMany(repositoryId, [])).resolves.toBe(0);
    await expect(commits.count(repositoryId)).resolves.toBe(0);
  });

  it('ignores commits it already has, so overlapping windows are free', async () => {
    const batch = [commit({ hash: 'a' }), commit({ hash: 'b' })];

    await commits.insertMany(repositoryId, batch);
    await commits.insertMany(repositoryId, batch);

    await expect(commits.count(repositoryId)).resolves.toBe(2);
  });

  it('handles a batch larger than one insert chunk', async () => {
    const many = FakeBitbucketClient.generateCommits(450, NOW);

    await commits.insertMany(repositoryId, many);

    await expect(commits.count(repositoryId)).resolves.toBe(450);
  });

  it('reports the newest commit timestamp', async () => {
    await commits.insertMany(repositoryId, [
      commit({ hash: 'old', committedAt: '2026-01-01T00:00:00.000Z' }),
      commit({ hash: 'new', committedAt: '2026-08-01T00:00:00.000Z' }),
    ]);

    const latest = await commits.latestCommitAt(repositoryId);

    expect(latest!.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('reports null for a repository with no commits', async () => {
    await expect(commits.latestCommitAt(repositoryId)).resolves.toBeNull();
  });

  describe('activitySince', () => {
    it('counts commits and distinct authors in the window', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'a', authorEmail: 'ada@demandai.co' }),
        commit({ hash: 'b', authorEmail: 'alan@demandai.co' }),
        commit({ hash: 'c', authorEmail: 'ada@demandai.co' }),
      ]);

      const activity = await commits.activitySince(
        repositoryId,
        new Date('2026-01-01T00:00:00.000Z'),
      );

      expect(activity.commits).toBe(3);
      expect(activity.authors).toBe(2);
    });

    it('excludes merge commits, which are not authorship', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'real', parentCount: 1 }),
        commit({ hash: 'merge', parentCount: 2 }),
      ]);

      const activity = await commits.activitySince(
        repositoryId,
        new Date('2026-01-01T00:00:00.000Z'),
      );

      expect(activity.commits).toBe(1);
    });

    it('excludes commits older than the window', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'inside', committedAt: '2026-08-01T00:00:00.000Z' }),
        commit({ hash: 'outside', committedAt: '2025-01-01T00:00:00.000Z' }),
      ]);

      const activity = await commits.activitySince(
        repositoryId,
        new Date('2026-06-01T00:00:00.000Z'),
      );

      expect(activity.commits).toBe(1);
      // lastCommitAt reports all-time, not window-limited.
      expect(activity.lastCommitAt!.toISOString()).toBe(
        '2026-08-01T00:00:00.000Z',
      );
    });

    it('does not count authorless commits towards distinct authors', async () => {
      await commits.insertMany(repositoryId, [
        commit({ hash: 'a', authorEmail: undefined }),
        commit({ hash: 'b', authorEmail: 'ada@demandai.co' }),
      ]);

      const activity = await commits.activitySince(
        repositoryId,
        new Date('2026-01-01T00:00:00.000Z'),
      );

      expect(activity.commits).toBe(2);
      expect(activity.authors).toBe(1);
    });
  });

  it('keeps commits from different repositories apart', async () => {
    await repositories.syncWorkspace(
      'demandai',
      [repository('oxp-backend'), repository('crm')],
      NOW,
    );
    const other = await repositories.findByEntityRef('component:default/crm');

    await commits.insertMany(repositoryId, [commit({ hash: 'a' })]);
    await commits.insertMany(other!.id, [commit({ hash: 'a' })]);

    await expect(commits.count(repositoryId)).resolves.toBe(1);
    await expect(commits.count(other!.id)).resolves.toBe(1);
  });
});
