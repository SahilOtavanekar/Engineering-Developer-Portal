import type {
  BitbucketPipelineRun,
  BitbucketRepository,
} from '../bitbucket/types';
import {
  startFleetTestDatabase,
  type FleetTestDatabase,
} from '../__testUtils__/database';
import { PipelineStore } from './PipelineStore';
import { RepositoryStore } from './RepositoryStore';

const NOW = new Date('2026-08-24T12:00:00.000Z');

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

let seq = 0;
function run(
  state: string,
  result: string | undefined,
  minutesAgo = ++seq,
): BitbucketPipelineRun {
  return {
    uuid: `{run-${state}-${result ?? 'none'}-${minutesAgo}}`,
    buildNumber: minutesAgo,
    state,
    result,
    createdAt: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  };
}

describe('PipelineStore.summary', () => {
  let db: FleetTestDatabase;
  let pipelines: PipelineStore;
  let repositories: RepositoryStore;
  let repositoryId: number;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    pipelines = new PipelineStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    seq = 0;
    await db.client('pipeline_run').delete();
    await db.client('repository').delete();
    await repositories.syncWorkspace('demandai', [repository()], NOW);
    const stored = await repositories.findByEntityRef(
      'component:default/oxp-backend',
    );
    repositoryId = stored!.id;
  });

  it('reports the four states section 6 asks for', async () => {
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'SUCCESSFUL'),
      run('COMPLETED', 'SUCCESSFUL'),
      run('COMPLETED', 'FAILED'),
      run('COMPLETED', 'STOPPED'),
      run('IN_PROGRESS', undefined),
    ]);

    await expect(pipelines.summary(repositoryId)).resolves.toMatchObject({
      successful: 2,
      failed: 1,
      cancelled: 1,
      inProgress: 1,
    });
  });

  it('does not count a cancelled run as a failure', async () => {
    // The estate has 27 STOPPED runs, every one of which was being reported as
    // a failure and scored as one.
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'SUCCESSFUL'),
      run('COMPLETED', 'STOPPED'),
    ]);

    const summary = await pipelines.summary(repositoryId);

    expect(summary.failed).toBe(0);
    expect(summary.cancelled).toBe(1);
  });

  it('leaves cancelled runs out of the judged denominator', async () => {
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'SUCCESSFUL'),
      run('COMPLETED', 'SUCCESSFUL'),
      run('COMPLETED', 'STOPPED'),
      run('IN_PROGRESS', undefined),
    ]);

    const summary = await pipelines.summary(repositoryId);

    expect(summary.completed).toBe(3);
    expect(summary.judged).toBe(2);
  });

  it('treats an expired run as cancelled, not failed', async () => {
    // Nobody let it finish, so it says nothing about the code either way.
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'EXPIRED'),
    ]);

    await expect(pipelines.summary(repositoryId)).resolves.toMatchObject({
      cancelled: 1,
      failed: 0,
      judged: 0,
    });
  });

  it('treats an errored run as a failure', async () => {
    // ERROR is a build that broke, unlike one that was stopped.
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'ERROR'),
    ]);

    await expect(pipelines.summary(repositoryId)).resolves.toMatchObject({
      failed: 1,
      cancelled: 0,
    });
  });

  it('treats an unfamiliar result as a failure rather than ignoring it', async () => {
    // Derived by subtraction on purpose: a result Bitbucket adds later should
    // show up as something to investigate, not vanish from every total.
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'SOMETHING_NEW'),
    ]);

    await expect(pipelines.summary(repositoryId)).resolves.toMatchObject({
      failed: 1,
      cancelled: 0,
    });
  });

  it('reports nothing to judge for a repository with no runs', async () => {
    await expect(pipelines.summary(repositoryId)).resolves.toMatchObject({
      completed: 0,
      judged: 0,
      successful: 0,
      failed: 0,
      cancelled: 0,
      inProgress: 0,
    });
  });

  it('reports the newest run last seen', async () => {
    await pipelines.replaceForRepository(repositoryId, [
      run('COMPLETED', 'FAILED', 1),
      run('COMPLETED', 'SUCCESSFUL', 500),
    ]);

    const summary = await pipelines.summary(repositoryId);

    expect(summary.lastResult).toBe('FAILED');
    expect(summary.lastRunAt).toEqual(new Date(NOW.getTime() - 60_000));
  });
});

describe('PipelineStore.lastRunForRepositories', () => {
  let db: FleetTestDatabase;
  let pipelines: PipelineStore;
  let repositories: RepositoryStore;

  beforeAll(async () => {
    db = await startFleetTestDatabase();
    pipelines = new PipelineStore(db.client);
    repositories = new RepositoryStore(db.client);
  });

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.client('pipeline_run').delete();
    await db.client('repository').delete();
  });

  /** Registers three repositories and returns their ids by slug. */
  async function seed(): Promise<Map<string, number>> {
    await repositories.syncWorkspace(
      'demandai',
      [repository('busy'), repository('quiet'), repository('never-built')],
      NOW,
    );
    const ids = new Map<string, number>();
    for (const slug of ['busy', 'quiet', 'never-built']) {
      const stored = await repositories.findByEntityRef(
        `component:default/${slug}`,
      );
      ids.set(slug, stored!.id);
    }
    return ids;
  }

  it('returns the newest run per repository', async () => {
    const ids = await seed();
    await pipelines.replaceForRepository(ids.get('busy')!, [
      {
        uuid: '{old}',
        state: 'COMPLETED',
        result: 'SUCCESSFUL',
        createdAt: '2026-08-20T09:00:00.000Z',
      },
      {
        uuid: '{new}',
        state: 'COMPLETED',
        result: 'FAILED',
        createdAt: '2026-08-24T11:30:00.000Z',
      },
    ]);

    const map = await pipelines.lastRunForRepositories([...ids.values()]);

    expect(map.get(ids.get('busy')!)).toEqual(
      new Date('2026-08-24T11:30:00.000Z'),
    );
  });

  it('omits a repository that has never run a pipeline', async () => {
    // Absent rather than null, so the caller cannot mistake "never built" for
    // a run that happened at the epoch and float it to the top of the estate.
    const ids = await seed();
    await pipelines.replaceForRepository(ids.get('busy')!, [
      {
        uuid: '{a}',
        state: 'COMPLETED',
        result: 'SUCCESSFUL',
        createdAt: '2026-08-24T11:30:00.000Z',
      },
    ]);

    const map = await pipelines.lastRunForRepositories([...ids.values()]);

    expect(map.has(ids.get('never-built')!)).toBe(false);
    expect(map.size).toBe(1);
  });

  it('counts a run whatever its state, including one still going', async () => {
    // The estate order is about when a repository last built, not whether the
    // build passed -- the score already carries that.
    const ids = await seed();
    await pipelines.replaceForRepository(ids.get('quiet')!, [
      {
        uuid: '{running}',
        state: 'IN_PROGRESS',
        result: undefined,
        createdAt: '2026-08-24T10:00:00.000Z',
      },
    ]);

    const map = await pipelines.lastRunForRepositories([...ids.values()]);

    expect(map.get(ids.get('quiet')!)).toEqual(
      new Date('2026-08-24T10:00:00.000Z'),
    );
  });

  it('returns an empty map for no repositories, without querying', async () => {
    await expect(pipelines.lastRunForRepositories([])).resolves.toEqual(
      new Map(),
    );
  });
});
