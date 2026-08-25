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

function repository(): BitbucketRepository {
  return {
    workspace: 'demandai',
    slug: 'oxp-backend',
    name: 'oxp-backend',
    url: 'https://bitbucket.org/demandai/oxp-backend',
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
