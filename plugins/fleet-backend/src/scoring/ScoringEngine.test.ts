import type { RepositoryRecord } from '../database/RepositoryStore';
import { bandFor, PROVISIONAL_BANDS, ScoringEngine } from './ScoringEngine';
import { activeCommitsScorer } from './scorers/activeCommits';
import { activeContributorsScorer } from './scorers/activeContributors';
import { branchHygieneScorer } from './scorers/branchHygiene';
import { codeReviewCompletedScorer } from './scorers/codeReviewCompleted';
import { pipelineHealthScorer } from './scorers/pipelineHealth';
import { readmeAvailableScorer } from './scorers/readmeAvailable';
import { ownerAssignedScorer } from './scorers/ownerAssigned';
import { pullRequestDisciplineScorer } from './scorers/pullRequestDiscipline';
import { OWNERSHIP_SOURCE_REGISTER } from '../ownership/types';
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

    // toMatchObject, not toEqual: the entry gained `remediation` and an exact
    // match makes every future field addition look like a regression here.
    expect(result.breakdown).toMatchObject([
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
    expect(scorer.score(withReadme(false))).toMatchObject({
      fraction: 0,
      detail: 'No README at the repository root',
    });
  });
});

describe('ownerAssignedScorer', () => {
  const scorer = ownerAssignedScorer();
  const owner = (over: Record<string, unknown> = {}) =>
    ({
      rank: 1,
      isProposed: true,
      name: 'Brijesh Gupta',
      email: 'brijesh.gupta@demandai.co',
      commits: 175,
      windowCommits: 202,
      windowDays: 90,
      source: OWNERSHIP_SOURCE_REGISTER,
      resolvedAt: NOW,
      ...over,
    } as any);

  const withOwnership = (ownership: any) => ({ ...context(10, 2), ownership });

  it('cannot measure before ownership has ever been resolved', () => {
    // Not zero. Ninety-five repositories scored zero because a scheduled task
    // has not run yet would misreport every one of them.
    expect(scorer.score(withOwnership(undefined))).toBeNull();
  });

  it('gives full marks for an owner somebody confirmed', () => {
    expect(scorer.score(withOwnership({ proposed: owner() }))).toEqual({
      fraction: 1,
      detail: 'Owner confirmed: Brijesh Gupta',
    });
  });

  it('gives nothing for an owner derived from admin permission', () => {
    // The inference was right 76% of the time against the register. Good enough
    // to suggest a name, nowhere near good enough to count as ownership.
    const outcome = scorer.score(
      withOwnership({ proposed: owner({ source: 'repository-admin' }) }),
    );

    expect(outcome?.fraction).toBe(0);
    expect(outcome?.detail).toContain('nobody has confirmed it');
    expect(outcome?.detail).toContain('repository-admin');
  });

  it('gives nothing for an owner derived from commit history', () => {
    const outcome = scorer.score(
      withOwnership({ proposed: owner({ source: 'commit-history' }) }),
    );

    expect(outcome?.fraction).toBe(0);
  });

  it('scores zero, not null, when a pass ran and found nobody', () => {
    // The distinction the context type exists for: resolved-and-empty is a real
    // zero, never-resolved is unmeasurable.
    expect(scorer.score(withOwnership({}))).toMatchObject({
      fraction: 0,
      detail: 'No owner identified',
    });
  });

  it('treats a candidate with no address as no owner', () => {
    // Without a resolvable address there is no User entity to own anything, so
    // the catalog shows the placeholder owner and this must agree with it.
    expect(
      scorer.score(withOwnership({ proposed: owner({ email: undefined }) })),
    ).toMatchObject({ fraction: 0, detail: 'No owner identified' });
  });

  it('falls back to the address when the register has no name', () => {
    const outcome = scorer.score(
      withOwnership({ proposed: owner({ name: undefined }) }),
    );

    expect(outcome?.detail).toBe('Owner confirmed: brijesh.gupta@demandai.co');
  });

  it('earns its full weight in the total', () => {
    // The point of the exercise: the ten points this metric forfeited while it
    // had no data source are now winnable.
    const result = new ScoringEngine({
      bands: PROVISIONAL_BANDS,
      scorers: [
        { scorer: fixed('measured', 1), weight: 90 },
        { scorer: ownerAssignedScorer(), weight: 10 },
      ],
    }).score(withOwnership({ proposed: owner() }));

    expect(result.total).toBe(100);
    expect(result.availableWeight).toBe(100);
    expect(result.breakdown.find(e => e.id === 'owner-assigned')).toMatchObject(
      { points: 10, available: true },
    );
  });
});

describe('remediation', () => {
  const withRemediation = (fraction: number): Scorer => ({
    id: 'fixable',
    title: 'Fixable',
    score: () => ({ fraction, detail: 'detail', remediation: 'do the thing' }),
  });

  const run = (scorer: Scorer) =>
    new ScoringEngine({
      bands: PROVISIONAL_BANDS,
      scorers: [{ scorer, weight: 10 }],
    }).score(context(10, 2)).breakdown[0];

  it('carries the remediation the scorer supplied when points were lost', () => {
    expect(run(withRemediation(0.4))).toMatchObject({
      points: 4,
      remediation: 'do the thing',
    });
  });

  it('drops it at full marks, where it is noise', () => {
    expect(run(withRemediation(1)).remediation).toBeUndefined();
  });

  it('omits it entirely when the scorer had nothing to say', () => {
    // activeCommits deliberately stays silent for a repository with no commits
    // at all: "commit more" answers neither the scaffold case nor the
    // abandoned one.
    const silent: Scorer = {
      id: 'silent',
      title: 'Silent',
      score: () => ({ fraction: 0, detail: 'nothing happened' }),
    };

    expect(run(silent).remediation).toBeUndefined();
  });

  it('is absent on an unmeasurable metric', () => {
    expect(
      new ScoringEngine({
        bands: PROVISIONAL_BANDS,
        scorers: [{ scorer: unmeasurable, weight: 10 }],
      }).score(context(10, 2)).breakdown[0].remediation,
    ).toBeUndefined();
  });
});

describe('scorers supply their own remediation', () => {
  it('activeCommits quotes the configured target, not a hardcoded one', () => {
    // The whole reason remediation lives in the scorer: the target is config,
    // and a frontend lookup table would drift the moment it was tuned.
    const outcome = activeCommitsScorer({ target: 25 }).score(context(5, 1));

    expect(outcome?.remediation).toContain('25 commits in 90 days');
    expect(outcome?.remediation).toContain('this has 5');
  });

  it('activeCommits says nothing to a repository with no commits', () => {
    expect(
      activeCommitsScorer({ target: 10 }).score(context(0, 0))?.remediation,
    ).toBeUndefined();
  });

  it('readmeAvailable names the file to add', () => {
    const outcome = readmeAvailableScorer().score({
      ...context(10, 2),
      repository: { ...context(10, 2).repository, has_readme: false },
    });

    expect(outcome?.remediation).toContain('README.md');
  });

  it('readmeAvailable stays silent when the README exists', () => {
    const outcome = readmeAvailableScorer().score({
      ...context(10, 2),
      repository: { ...context(10, 2).repository, has_readme: true },
    });

    expect(outcome?.remediation).toBeUndefined();
  });
});

describe('the registered scorecard', () => {
  it('is a set of weights that totals exactly 100', () => {
    // Pinned because the total drifted twice: adding the ownership metric took
    // it to 100, adding pull-request discipline took it to 110, and dropping
    // the security scan brought it back. A silent drift rescales every score in
    // the estate.
    const registered = [20, 10, 20, 10, 10, 10, 10, 10];

    expect(registered).toHaveLength(8);
    expect(registered.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe('pullRequestDisciplineScorer', () => {
  const scorer = pullRequestDisciplineScorer({ windowDays: 30 });
  const withPolicy = (policy: any) => ({
    ...context(10, 2),
    branchPolicy: policy,
  });
  const policy = (o: Partial<Record<string, any>> = {}) => ({
    mainline: 0,
    viaPullRequest: 0,
    direct: 0,
    directMerge: 0,
    mergedIn: 0,
    branch: 'main',
    ...o,
  });

  it('cannot measure before the classification pass has run', () => {
    expect(scorer.score(withPolicy(undefined))).toBeNull();
  });

  it('cannot measure a repository where nothing landed in the window', () => {
    // 48 of 95 repositories are dormant. Scoring them zero here would punish
    // them twice for the same silence.
    expect(scorer.score(withPolicy(policy({ mainline: 0 })))).toBeNull();
  });

  it('gives full marks when everything came through a pull request', () => {
    const outcome = scorer.score(
      withPolicy(policy({ mainline: 22, viaPullRequest: 22 })),
    );

    expect(outcome?.fraction).toBe(1);
    expect(outcome?.detail).toContain('all 22 commits on main');
  });

  it('grades by share rather than passing or failing', () => {
    // One direct commit in fifty is a slip; eleven in eleven is a repository
    // with no review at all. Scoring both zero tells the second team nothing.
    const slip = scorer.score(
      withPolicy(policy({ mainline: 50, viaPullRequest: 49, direct: 1 })),
    );
    const none = scorer.score(
      withPolicy(policy({ mainline: 11, viaPullRequest: 0, direct: 11 })),
    );

    expect(slip!.fraction).toBeCloseTo(0.98);
    expect(none!.fraction).toBe(0);
  });

  it('reports all three ways work reached main, separately', () => {
    // Merged-without-a-pull-request and written-straight-on-main need
    // different fixes, so one combined total would hide which you have.
    const outcome = scorer.score(
      withPolicy(
        policy({ mainline: 20, viaPullRequest: 4, direct: 12, directMerge: 4 }),
      ),
    );

    expect(outcome?.detail).toBe(
      '20 commits reached main in 30 days: 4 through a pull request, ' +
        '4 merged from a branch with no pull request, 12 written directly on main',
    );
  });

  it('leaves out a route nothing took', () => {
    const outcome = scorer.score(
      withPolicy(policy({ mainline: 10, viaPullRequest: 9, direct: 1 })),
    );

    expect(outcome?.detail).not.toContain('merged from a branch');
    expect(outcome?.detail).toContain('1 written directly on main');
  });

  it('still counts a merge with no pull request against the score', () => {
    // It came from a branch, but nobody reviewed it -- so it is not the same
    // as a pull request, and the fraction must not treat it as one.
    const outcome = scorer.score(
      withPolicy(policy({ mainline: 10, viaPullRequest: 5, directMerge: 5 })),
    );

    expect(outcome?.fraction).toBeCloseTo(0.5);
  });

  it('ignores commits a merge brought in', () => {
    // mergedIn is reported so totals reconcile, never judged: those commits
    // were made on a feature branch, which is the behaviour we want.
    const outcome = scorer.score(
      withPolicy(policy({ mainline: 2, viaPullRequest: 2, mergedIn: 998 })),
    );

    expect(outcome?.fraction).toBe(1);
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
