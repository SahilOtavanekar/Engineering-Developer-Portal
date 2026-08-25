import type { RepositoryRecord } from '../database/RepositoryStore';
import { bandFor, PROVISIONAL_BANDS, ScoringEngine } from './ScoringEngine';
import { activeCommitsScorer } from './scorers/activeCommits';
import { activeContributorsScorer } from './scorers/activeContributors';
import { branchHygieneScorer } from './scorers/branchHygiene';
import { codeReviewCompletedScorer } from './scorers/codeReviewCompleted';
import { pipelineHealthScorer } from './scorers/pipelineHealth';
import { readmeAvailableScorer } from './scorers/readmeAvailable';
import { unmeasuredScorer } from './scorers/unmeasured';
import type { Scorer, ScorerContext } from './types';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function context(commits: number, authors: number): ScorerContext {
  return {
    repository: { id: 1, slug: 'oxp-backend' } as RepositoryRecord,
    activity: { commits, authors, lastCommitAt: NOW },
    windowDays: 90,
    now: NOW,
  };
}

/** A scorer that cannot measure anything, standing in for an unbuilt metric. */
const unmeasurable: Scorer = {
  id: 'security-scan',
  title: 'Security scan passing',
  score: () => null,
};

const fixed = (id: string, fraction: number): Scorer => ({
  id,
  title: id,
  score: () => ({ fraction, detail: 'fixed' }),
});

describe('bandFor', () => {
  const bands = PROVISIONAL_BANDS;

  it('places scores in the documented three bands', () => {
    expect(bandFor(100, bands)).toBe('healthy');
    expect(bandFor(70, bands)).toBe('healthy');
    expect(bandFor(69, bands)).toBe('needs-attention');
    expect(bandFor(40, bands)).toBe('needs-attention');
    expect(bandFor(39, bands)).toBe('critical');
    expect(bandFor(0, bands)).toBe('critical');
  });
});

describe('ScoringEngine', () => {
  const engine = (scorers: Array<{ scorer: Scorer; weight: number }>) =>
    new ScoringEngine({ scorers, bands: PROVISIONAL_BANDS });

  it('reports the nominal weight across every registered metric', () => {
    const subject = engine([
      { scorer: fixed('a', 1), weight: 20 },
      { scorer: unmeasurable, weight: 5 },
    ]);

    expect(subject.nominalWeight).toBe(25);
  });

  it('awards full marks when every metric is satisfied', () => {
    const result = engine([
      { scorer: fixed('a', 1), weight: 20 },
      { scorer: fixed('b', 1), weight: 10 },
    ]).score(context(50, 5));

    expect(result.total).toBe(100);
    expect(result.band).toBe('healthy');
    expect(result.availableWeight).toBe(30);
  });

  it('weights metrics against each other', () => {
    const result = engine([
      { scorer: fixed('heavy', 1), weight: 20 },
      { scorer: fixed('light', 0), weight: 10 },
    ]).score(context(0, 0));

    // 20 of 30 available.
    expect(result.total).toBe(67);
  });

  describe('metrics that cannot be measured', () => {
    it('excludes them from the total rather than scoring them zero', () => {
      const result = engine([
        { scorer: fixed('a', 1), weight: 20 },
        { scorer: unmeasurable, weight: 80 },
      ]).score(context(10, 2));

      // Without exclusion this would be 20/100 and read as Critical.
      expect(result.total).toBe(100);
      expect(result.availableWeight).toBe(20);
    });

    it('records them in the breakdown so the gap stays visible', () => {
      const result = engine([
        { scorer: fixed('a', 1), weight: 20 },
        { scorer: unmeasurable, weight: 5 },
      ]).score(context(10, 2));

      const entry = result.breakdown.find(b => b.id === 'security-scan');
      expect(entry).toMatchObject({
        available: false,
        detail: 'Not measured yet',
        weight: 5,
      });
      expect(entry?.points).toBeUndefined();
    });

    it('scores zero rather than dividing by zero when nothing is measurable', () => {
      const result = engine([{ scorer: unmeasurable, weight: 100 }]).score(
        context(10, 2),
      );

      expect(result.total).toBe(0);
      expect(result.availableWeight).toBe(0);
      expect(result.band).toBe('critical');
    });
  });

  it('ignores metrics registered with no weight', () => {
    const result = engine([
      { scorer: fixed('a', 1), weight: 20 },
      { scorer: fixed('b', 0), weight: 0 },
    ]).score(context(10, 2));

    expect(result.breakdown.map(b => b.id)).toEqual(['a']);
  });

  it('clamps a misbehaving scorer into range', () => {
    const result = engine([{ scorer: fixed('over', 5), weight: 10 }]).score(
      context(0, 0),
    );

    expect(result.total).toBe(100);
  });

  it('explains every metric it scored', () => {
    const result = engine([
      { scorer: activeCommitsScorer({ target: 10 }), weight: 20 },
      { scorer: activeContributorsScorer({ target: 2 }), weight: 10 },
    ]).score(context(5, 1));

    expect(result.breakdown).toEqual([
      {
        id: 'active-commits',
        title: 'Active commits',
        weight: 20,
        points: 10,
        detail: '5 commits in 90 days',
        available: true,
      },
      {
        id: 'active-contributors',
        title: 'Active contributors',
        weight: 10,
        points: 5,
        detail: '1 contributor in 90 days',
        available: true,
      },
    ]);
    expect(result.total).toBe(50);
  });
});

describe('activeCommitsScorer', () => {
  const scorer = activeCommitsScorer({ target: 10 });

  it('gives nothing to a repository with no commits', () => {
    const outcome = scorer.score(context(0, 0));
    expect(outcome).toEqual({
      fraction: 0,
      detail: 'No commits in 90 days',
    });
  });

  it('grades partial activity against the target', () => {
    expect(scorer.score(context(5, 1))?.fraction).toBe(0.5);
  });

  it('caps at the target so a busy repository is not scored higher than full', () => {
    expect(scorer.score(context(500, 5))?.fraction).toBe(1);
  });

  it('singularises a single commit', () => {
    expect(scorer.score(context(1, 1))?.detail).toBe('1 commit in 90 days');
  });

  it('refuses a target below one', () => {
    expect(
      activeCommitsScorer({ target: 0 }).score(context(1, 1))?.fraction,
    ).toBe(1);
  });
});

describe('activeContributorsScorer', () => {
  const scorer = activeContributorsScorer({ target: 2 });

  it('treats a single-author repository as a bus-factor risk', () => {
    expect(scorer.score(context(50, 1))?.fraction).toBe(0.5);
  });

  it('gives full marks once the target is met', () => {
    expect(scorer.score(context(50, 2))?.fraction).toBe(1);
    expect(scorer.score(context(50, 9))?.fraction).toBe(1);
  });

  it('gives nothing to a repository nobody has touched', () => {
    expect(scorer.score(context(0, 0))).toEqual({
      fraction: 0,
      detail: 'No contributors in 90 days',
    });
  });
});

describe('pipelineHealthScorer', () => {
  const scorer = pipelineHealthScorer();
  const withRuns = (
    successful: number,
    completed: number,
    inProgress = 0,
    cancelled = 0,
  ) => ({
    ...context(10, 2),
    pipelines: {
      completed,
      successful,
      failed: completed - successful - cancelled,
      cancelled,
      inProgress,
      judged: completed - cancelled,
      lastResult: 'SUCCESSFUL',
    },
  });

  it('cannot measure a repository that has never run a pipeline', () => {
    expect(scorer.score(context(10, 2))).toBeNull();
    expect(scorer.score(withRuns(0, 0))).toBeNull();
  });

  it('scores the success rate over recent runs', () => {
    expect(scorer.score(withRuns(8, 10))?.fraction).toBe(0.8);
    expect(scorer.score(withRuns(8, 10))?.detail).toBe(
      '8 of 10 recent runs passed',
    );
  });

  it('does not take a repository to zero for a single failure', () => {
    expect(scorer.score(withRuns(19, 20))?.fraction).toBe(0.95);
  });

  it('gives nothing when every run failed', () => {
    expect(scorer.score(withRuns(0, 5))?.fraction).toBe(0);
  });

  it('singularises a single run', () => {
    expect(scorer.score(withRuns(1, 1))?.detail).toBe(
      '1 of 1 recent run passed',
    );
  });

  it('ignores runs still in progress', () => {
    // Three running, two completed and both passed: full marks, not 2/5.
    expect(scorer.score(withRuns(2, 2, 3))?.fraction).toBe(1);
  });
  it('does not count a cancelled run as a failure', () => {
    // A build somebody stopped, usually because a newer commit superseded it,
    // is not evidence that the code is broken. 27 of this estate's finished
    // runs are in this state and were being scored as failures.
    const result = scorer.score(withRuns(8, 10, 0, 2) as any);

    expect(result?.fraction).toBe(1);
    expect(result?.detail).toBe('8 of 8 recent runs passed, 2 cancelled');
  });

  it('is unmeasurable when every finished run was cancelled', () => {
    // Nothing to judge is not the same as everything failing.
    expect(scorer.score(withRuns(0, 3, 0, 3) as any)).toBeNull();
  });

  it('says nothing about cancellations when there were none', () => {
    expect(scorer.score(withRuns(9, 10) as any)?.detail).toBe(
      '9 of 10 recent runs passed',
    );
  });
});

describe('branchHygieneScorer', () => {
  const scorer = branchHygieneScorer();
  const withBranches = (active: number, total: number) => ({
    ...context(10, 2),
    branches: { total, active, stale: total - active },
  });

  it('cannot measure a repository with no branches', () => {
    expect(scorer.score(context(10, 2))).toBeNull();
    expect(scorer.score(withBranches(0, 0))).toBeNull();
  });

  it('scores the fraction of branches still being worked on', () => {
    expect(scorer.score(withBranches(3, 10))?.fraction).toBe(0.3);
  });

  it('gives full marks when nothing is stale', () => {
    expect(scorer.score(withBranches(2, 2))?.fraction).toBe(1);
  });

  it('explains the count', () => {
    expect(scorer.score(withBranches(3, 22))?.detail).toBe(
      '3 of 22 branches active in 90 days',
    );
  });

  it('singularises a single branch', () => {
    expect(scorer.score(withBranches(1, 1))?.detail).toBe(
      '1 of 1 branch active in 90 days',
    );
  });
});

describe('codeReviewCompletedScorer', () => {
  const scorer = codeReviewCompletedScorer();
  const withReviews = (approved: number, merged: number) => ({
    ...context(10, 2),
    reviews: { merged, approved, open: 0 },
  });

  it('cannot measure a repository with no merged pull requests', () => {
    expect(scorer.score(context(10, 2))).toBeNull();
    expect(scorer.score(withReviews(0, 0))).toBeNull();
  });

  it('scores the fraction of merges that were approved', () => {
    expect(scorer.score(withReviews(4, 10))?.fraction).toBe(0.4);
  });

  it('gives nothing when everything was self-merged', () => {
    expect(scorer.score(withReviews(0, 5))?.fraction).toBe(0);
  });

  it('gives full marks when everything was reviewed', () => {
    expect(scorer.score(withReviews(10, 10))?.fraction).toBe(1);
  });

  it('explains the ratio', () => {
    expect(scorer.score(withReviews(4, 10))?.detail).toBe(
      '4 of 10 merged PRs approved in 90 days',
    );
  });

  it('singularises a single pull request', () => {
    expect(scorer.score(withReviews(1, 1))?.detail).toBe(
      '1 of 1 merged PR approved in 90 days',
    );
  });
});

describe('readmeAvailableScorer', () => {
  const scorer = readmeAvailableScorer();
  const withReadme = (has_readme: boolean | null) => ({
    ...context(10, 2),
    repository: { ...context(10, 2).repository, has_readme },
  });

  it('cannot measure before the root listing has been fetched', () => {
    expect(scorer.score(withReadme(null))).toBeNull();
  });

  it('gives full marks when a README exists', () => {
    expect(scorer.score(withReadme(true))).toEqual({
      fraction: 1,
      detail: 'README present at the repository root',
    });
  });

  it('gives nothing when there is none', () => {
    expect(scorer.score(withReadme(false))).toEqual({
      fraction: 0,
      detail: 'No README at the repository root',
    });
  });
});

describe('unmeasuredScorer', () => {
  it('always reports that it cannot measure', () => {
    const scorer = unmeasuredScorer('owner-assigned', 'Owner assigned');

    expect(scorer.id).toBe('owner-assigned');
    expect(scorer.title).toBe('Owner assigned');
    expect(scorer.score(context(10, 2))).toBeNull();
  });

  it('keeps its weight visible in the breakdown', () => {
    const result = new ScoringEngine({
      bands: PROVISIONAL_BANDS,
      scorers: [
        { scorer: fixed('measured', 1), weight: 85 },
        {
          scorer: unmeasuredScorer('owner-assigned', 'Owner assigned'),
          weight: 10,
        },
        {
          scorer: unmeasuredScorer('security-scan', 'Security scan'),
          weight: 5,
        },
      ],
    }).score(context(10, 2));

    expect(result.total).toBe(100);
    expect(result.availableWeight).toBe(85);
    expect(
      result.breakdown.filter(b => !b.available).map(b => b.weight),
    ).toEqual([10, 5]);
  });
});
