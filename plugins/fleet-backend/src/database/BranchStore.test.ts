import type { BitbucketBranch, BitbucketRepository } from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { BranchStore } from './BranchStore';
import { RepositoryStore } from './RepositoryStore';

const NOW = new Date('2026-09-09T12:00:00.000Z');
/** 90 days before NOW: anything older than this is stale. */
const STALE_BEFORE = new Date('2026-06-11T12:00:00.000Z');
const DAY = 86_400_000;

function repository(): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug: 'oxp-backend',
    name: 'oxp-backend',
    url: 'https://bitbucket.org/demandai/oxp-backend',
    isPrivate: true,
    defaultBranch: 'main',
    createdAt: '2023-05-01T10:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
  };
}

const branch = (name: string, daysAgo: number | null): BitbucketBranch => ({
  name,
  lastCommitAt:
    daysAgo === null
      ? undefined
      : new Date(NOW.getTime() - daysAgo * DAY).toISOString(),
  lastCommitHash: `${name}-head`,
});

/**
 * `BranchStore`'s staleness accounting, which the "No stale branches" metric is
 * built on and which nothing exercised directly before this file: it was only
 * reached through `RepositoryDetailIngestionService`, so the exemption logic and
 * the default-branch exclusion had no coverage of their own.
 */
describe('BranchStore staleness', () => {
  let db: FleetTestDatabase;
  let branches: BranchStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    branches = new BranchStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('branch').delete();
    await db.client('repository').delete();
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    repositoryId = stored!.id;
  });

  async function seed(rows: BitbucketBranch[]) {
    await branches.replaceForRepository(repositoryId, rows, 'main');
  }

  describe('summary', () => {
    it('counts branches inside and outside the window', async () => {
      await seed([
        branch('main', 1),
        branch('feature-a', 5),
        branch('old-one', 200),
        branch('old-two', 400),
      ]);

      await expect(
        branches.summary(repositoryId, STALE_BEFORE),
      ).resolves.toMatchObject({ total: 4, active: 2, stale: 2 });
    });

    /**
     * The default branch's own staleness is `mainBranchCurrent`'s job. It can
     * never be "a stale branch that should be removed", so counting it here
     * would penalise a quiet repository twice for one fact -- and would suggest
     * deleting the branch the repository is built on.
     */
    it('never counts the default branch as one to delete', async () => {
      await seed([branch('main', 300), branch('feature-a', 2)]);

      const summary = await branches.summary(repositoryId, STALE_BEFORE);

      expect(summary.stale).toBe(1);
      expect(summary.staleActionable).toBe(0);
    });

    it('treats a branch with no timestamp as stale', async () => {
      // Either empty or never measured, and neither is evidence of work.
      await seed([branch('main', 1), branch('mystery', null)]);

      await expect(
        branches.summary(repositoryId, STALE_BEFORE),
      ).resolves.toMatchObject({ staleActionable: 1, staleExempt: 0 });
    });

    describe('exemptions', () => {
      it('spares an exempt branch and reports it separately', async () => {
        await seed([
          branch('main', 1),
          branch('stage', 300),
          branch('abandoned', 300),
        ]);

        const summary = await branches.summary(repositoryId, STALE_BEFORE, {
          exempt: ['stage'],
        });

        expect(summary.stale).toBe(2);
        expect(summary.staleActionable).toBe(1);
        expect(summary.staleExempt).toBe(1);
      });

      /**
       * This estate is already demonstrably inconsistent about case in branch
       * and environment names, so an exemption that only matched one spelling
       * would silently fail on the repositories that spell it differently.
       */
      it('matches case-insensitively', async () => {
        await seed([branch('main', 1), branch('Stage', 300)]);

        await expect(
          branches.summary(repositoryId, STALE_BEFORE, { exempt: ['stage'] }),
        ).resolves.toMatchObject({ staleActionable: 0, staleExempt: 1 });
      });

      it('does not exempt an active branch, which needs no forgiving', async () => {
        await seed([branch('main', 1), branch('stage', 2)]);

        await expect(
          branches.summary(repositoryId, STALE_BEFORE, { exempt: ['stage'] }),
        ).resolves.toMatchObject({ staleActionable: 0, staleExempt: 0 });
      });

      it('ignores an exemption for a branch that does not exist', async () => {
        await seed([branch('main', 1), branch('abandoned', 300)]);

        await expect(
          branches.summary(repositoryId, STALE_BEFORE, {
            exempt: ['release', 'uat'],
          }),
        ).resolves.toMatchObject({ staleActionable: 1, staleExempt: 0 });
      });
    });
  });

  describe('stalest', () => {
    it('names the longest-abandoned first, excluding the default branch', async () => {
      await seed([
        branch('main', 300),
        branch('recent-ish', 100),
        branch('ancient', 400),
      ]);

      const stalest = await branches.stalest(repositoryId, STALE_BEFORE);

      expect(stalest.map(b => b.name)).toEqual(['ancient', 'recent-ish']);
    });

    /**
     * The card and the score must agree. Naming a branch the score has already
     * forgiven reads as one of the two being broken, so `stalest` applies the
     * same exemptions the count does -- through `lower(name)`, which is the one
     * spelling that works on both Postgres and the SQLite this suite runs.
     */
    it('applies the same exemptions the count applies', async () => {
      await seed([
        branch('main', 1),
        branch('stage', 400),
        branch('abandoned', 300),
      ]);

      const stalest = await branches.stalest(repositoryId, STALE_BEFORE, 5, {
        exempt: ['stage'],
      });

      expect(stalest.map(b => b.name)).toEqual(['abandoned']);
    });

    it('matches an exemption case-insensitively here too', async () => {
      await seed([branch('main', 1), branch('DEV', 400)]);

      await expect(
        branches.stalest(repositoryId, STALE_BEFORE, 5, { exempt: ['dev'] }),
      ).resolves.toEqual([]);
    });

    it('returns nothing when every branch is current', async () => {
      await seed([branch('main', 1), branch('feature-a', 2)]);

      await expect(
        branches.stalest(repositoryId, STALE_BEFORE),
      ).resolves.toEqual([]);
    });
  });
});
