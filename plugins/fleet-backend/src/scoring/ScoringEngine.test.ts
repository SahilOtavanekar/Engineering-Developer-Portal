import type { RepositoryRecord } from '../database/RepositoryStore';
import { bandFor, DEFAULT_BANDS, ScoringEngine } from './ScoringEngine';
import { activeDevelopmentScorer } from './scorers/activeDevelopment';
import { mainBranchCurrentScorer } from './scorers/mainBranchCurrent';
import { describeAge, recencyLadder } from './scorers/recency';
import { pullRequestSizeScorer } from './scorers/pullRequestSize';
import { activeContributorsScorer } from './scorers/activeContributors';
import { staleBranchesScorer } from './scorers/staleBranches';
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
  const bands = DEFAULT_BANDS;

  it('places scores in the four documented bands', () => {
    expect(bandFor(100, bands)).toBe('excellent');
    expect(bandFor(90, bands)).toBe('excellent');
    expect(bandFor(89, bands)).toBe('healthy');
    expect(bandFor(75, bands)).toBe('healthy');
    expect(bandFor(74, bands)).toBe('needs-attention');
    expect(bandFor(60, bands)).toBe('needs-attention');
    expect(bandFor(59, bands)).toBe('at-risk');
    expect(bandFor(0, bands)).toBe('at-risk');
  });

  /**
   * The specification's own table, so a threshold edited by mistake fails here
   * rather than quietly re-banding the estate. These decide which teams are
   * told their repository is failing.
   */
  it('defaults to the specified thresholds', () => {
    expect(DEFAULT_BANDS).toEqual({
      excellent: 90,
      healthy: 75,
      needsAttention: 60,
    });
  });

  it('honours configured thresholds rather than the defaults', () => {
    const relaxed = { excellent: 80, healthy: 50, needsAttention: 20 };
    expect(bandFor(80, relaxed)).toBe('excellent');
    expect(bandFor(50, relaxed)).toBe('healthy');
    expect(bandFor(20, relaxed)).toBe('needs-attention');
    expect(bandFor(19, relaxed)).toBe('at-risk');
  });
});

describe('ScoringEngine', () => {
  const engine = (scorers: Array<{ scorer: Scorer; weight: number }>) =>
    new ScoringEngine({ scorers, bands: DEFAULT_BANDS });

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
    expect(result.band).toBe('excellent');
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

      // Without exclusion this would be 20/100 and read as At Risk.
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
      expect(result.band).toBe('at-risk');
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
      { scorer: mainBranchCurrentScorer(), weight: 20 },
      { scorer: activeContributorsScorer({ target: 2 }), weight: 10 },
    ]).score(context(5, 1));

    // toMatchObject, not toEqual: the entry gained `remediation` and an exact
    // match makes every future field addition look like a regression here.
    expect(result.breakdown).toMatchObject([
      {
        id: 'main-branch-current',
        title: 'Main branch up to date',
        weight: 20,
        points: 20,
        detail: 'Last commit to the default branch today',
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
    // 25 of 30 available.
    expect(result.total).toBe(83);
  });
});

describe('recencyLadder', () => {
  const bands = [
    { withinDays: 30, points: 20 },
    { withinDays: 60, points: 7 },
    { withinDays: 90, points: 3 },
  ];
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('reports each rung as a share of the top one', () => {
    expect(recencyLadder(daysAgo(0), NOW, bands).fraction).toBe(1);
    expect(recencyLadder(daysAgo(30), NOW, bands).fraction).toBe(1);
    expect(recencyLadder(daysAgo(31), NOW, bands).fraction).toBeCloseTo(7 / 20);
    expect(recencyLadder(daysAgo(60), NOW, bands).fraction).toBeCloseTo(7 / 20);
    expect(recencyLadder(daysAgo(61), NOW, bands).fraction).toBeCloseTo(3 / 20);
    expect(recencyLadder(daysAgo(90), NOW, bands).fraction).toBeCloseTo(3 / 20);
    expect(recencyLadder(daysAgo(91), NOW, bands).fraction).toBe(0);
  });

  /**
   * The fraction is relative to the top rung, so the same day boundaries with
   * a different reward shape produce different scores. Rule 6's 10/7/3 ladder
   * is markedly more forgiving of a slowdown than rule 1's 20/7/3.
   */
  it('makes the reward shape, not just the days, decide the score', () => {
    const gentle = [
      { withinDays: 30, points: 10 },
      { withinDays: 60, points: 7 },
      { withinDays: 90, points: 3 },
    ];

    expect(recencyLadder(daysAgo(45), NOW, gentle).fraction).toBeCloseTo(0.7);
    expect(recencyLadder(daysAgo(45), NOW, bands).fraction).toBeCloseTo(0.35);
  });

  it('treats never having any activity as a real zero', () => {
    expect(recencyLadder(null, NOW, bands)).toEqual({ fraction: 0 });
    expect(recencyLadder(undefined, NOW, bands).ageDays).toBeUndefined();
  });

  it('floors the age rather than rounding it across a boundary', () => {
    // 30.9 days is still inside the 30-day rung to a reader and to the score;
    // rounding to 31 would silently demote it.
    const at = new Date(NOW.getTime() - 30.9 * 86_400_000);

    expect(recencyLadder(at, NOW, bands).ageDays).toBe(30);
    expect(recencyLadder(at, NOW, bands).fraction).toBe(1);
  });

  /**
   * Committer dates come from whoever made the commit, so a skewed clock is
   * possible and is not the repository's fault. A negative age falling through
   * every rung would report an actively developed repository as abandoned.
   */
  it('treats a future timestamp as current rather than as ancient', () => {
    const ahead = new Date(NOW.getTime() + 5 * 86_400_000);

    expect(recencyLadder(ahead, NOW, bands).fraction).toBe(1);
    expect(recencyLadder(ahead, NOW, bands).ageDays).toBe(0);
  });

  it('describes an age the way a person would say it', () => {
    expect(describeAge(0)).toBe('today');
    expect(describeAge(1)).toBe('1 day ago');
    expect(describeAge(47)).toBe('47 days ago');
  });
});

describe('mainBranchCurrentScorer', () => {
  const scorer = mainBranchCurrentScorer();
  const withMainCommit = (at: Date | null) => ({
    ...context(10, 2),
    activity: { commits: 10, authors: 2, lastCommitAt: at },
    repository: { ...context(10, 2).repository, default_branch: 'main' },
  });
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  it('gives full marks for a commit inside 30 days', () => {
    expect(scorer.score(withMainCommit(daysAgo(2)))?.fraction).toBe(1);
  });

  it('follows the specification ladder as it ages', () => {
    expect(scorer.score(withMainCommit(daysAgo(45)))?.fraction).toBeCloseTo(
      7 / 20,
    );
    expect(scorer.score(withMainCommit(daysAgo(75)))?.fraction).toBeCloseTo(
      3 / 20,
    );
    expect(scorer.score(withMainCommit(daysAgo(200)))?.fraction).toBe(0);
  });

  it('names the branch it judged', () => {
    expect(scorer.score(withMainCommit(daysAgo(3)))?.detail).toBe(
      'Last commit to main 3 days ago',
    );
  });

  it('falls back to a generic name when the default branch is unknown', () => {
    const outcome = scorer.score({
      ...context(10, 2),
      activity: { commits: 1, authors: 1, lastCommitAt: daysAgo(1) },
    });

    expect(outcome?.detail).toBe('Last commit to the default branch 1 day ago');
  });

  /**
   * Zero, not unmeasurable. The bottom rung of the ladder is "no commit for
   * more than 90 days", and a repository that has never had one satisfies it.
   */
  it('scores a repository with no commits at all, rather than skipping it', () => {
    const outcome = scorer.score(withMainCommit(null));

    expect(outcome).not.toBeNull();
    expect(outcome?.fraction).toBe(0);
    expect(outcome?.detail).toBe('No commit has ever reached main');
  });

  it('says nothing to a repository with no commits at all', () => {
    // Same reason the old volume metric stayed silent: a scaffold and an
    // abandoned service need different things said, and the card says them.
    expect(scorer.score(withMainCommit(null))?.remediation).toBeUndefined();
  });

  it('quotes the day threshold rather than the points, which are configurable', () => {
    const outcome = scorer.score(withMainCommit(daysAgo(45)));

    expect(outcome?.remediation).toContain('every 30 days');
    expect(outcome?.remediation).toContain('45 days ago');
    // The weight is config, so an absolute figure here would be wrong the
    // moment it was retuned -- and is wrong today, at the interim weight.
    expect(outcome?.remediation).not.toContain('20 points');
  });

  it('drops the remediation at full marks', () => {
    expect(
      scorer.score(withMainCommit(daysAgo(1)))?.remediation,
    ).toBeUndefined();
  });
});

describe('activeDevelopmentScorer', () => {
  const scorer = activeDevelopmentScorer();
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
  const withActivity = (mainAt: Date | null, branchAt?: Date | null) => ({
    ...context(10, 2),
    activity: { commits: 10, authors: 2, lastCommitAt: mainAt },
    branches:
      branchAt === undefined
        ? undefined
        : {
            total: 3,
            active: 1,
            stale: 2,
            staleActionable: 2,
            staleExempt: 0,
            lastCommitAt: branchAt,
          },
  });

  it('gives full marks for activity inside 30 days', () => {
    expect(scorer.score(withActivity(daysAgo(5), daysAgo(5)))?.fraction).toBe(
      1,
    );
  });

  /**
   * The reason this is a separate metric from the main-branch one. Measured on
   * the estate, 22 of 98 repositories have branch activity more than a week
   * ahead of main; reading one timestamp for both rules would hide all of them.
   */
  it('counts work on a branch that has not reached main', () => {
    const outcome = scorer.score(withActivity(daysAgo(120), daysAgo(3)));

    expect(outcome?.fraction).toBe(1);
    expect(outcome?.detail).toBe(
      'Last commit 3 days ago (on a branch, not the default one)',
    );
  });

  it('says so plainly when the newest work is on main', () => {
    expect(scorer.score(withActivity(daysAgo(3), daysAgo(40)))?.detail).toBe(
      'Last commit 3 days ago',
    );
  });

  /**
   * Found by reading the stored details, not by reasoning about them:
   * `demand-ai-website` has a commit on main today and a branch head seconds
   * newer, and the note read "on a branch, not the default one" about a
   * repository whose main branch is perfectly current. The note exists to say
   * that credited activity is not reaching main, so it must stay quiet when
   * it is.
   */
  it('does not blame a branch when main is current too', () => {
    const mainToday = daysAgo(0);
    const branchSecondsNewer = new Date(mainToday.getTime() + 1000);

    expect(
      scorer.score(withActivity(mainToday, branchSecondsNewer))?.detail,
    ).toBe('Last commit today');
  });

  it('blames the branch once main has fallen behind', () => {
    expect(scorer.score(withActivity(daysAgo(45), daysAgo(2)))?.detail).toBe(
      'Last commit 2 days ago (on a branch, not the default one)',
    );
  });

  it('uses the gentler ladder the specification gives it', () => {
    // 10/7/3, not 20/7/3: a slowdown costs far less here than on main.
    expect(scorer.score(withActivity(daysAgo(45), null))?.fraction).toBeCloseTo(
      0.7,
    );
    expect(scorer.score(withActivity(daysAgo(75), null))?.fraction).toBeCloseTo(
      0.3,
    );
    expect(scorer.score(withActivity(daysAgo(200), null))?.fraction).toBe(0);
  });

  /**
   * `branches` is absent until the branch pass has covered the repository.
   * Without the fallback a busy repository would score zero on its first pass.
   */
  it('falls back to the default branch before branches are ingested', () => {
    const outcome = scorer.score(withActivity(daysAgo(4)));

    expect(outcome?.fraction).toBe(1);
    expect(outcome?.detail).toBe('Last commit 4 days ago');
  });

  it('scores a repository with nothing anywhere, rather than skipping it', () => {
    const outcome = scorer.score(withActivity(null, null));

    expect(outcome).not.toBeNull();
    expect(outcome?.fraction).toBe(0);
    expect(outcome?.detail).toBe('No commit on any branch');
    expect(outcome?.remediation).toBeUndefined();
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

describe('staleBranchesScorer', () => {
  const scorer = staleBranchesScorer();
  const withBranches = (
    staleActionable: number,
    staleExempt = 0,
    total = staleActionable + staleExempt + 1,
  ) => ({
    ...context(10, 2),
    branches: {
      total,
      active: 1,
      stale: staleActionable + staleExempt,
      staleActionable,
      staleExempt,
      lastCommitAt: NOW,
    },
  });

  it('cannot measure before the branch pass has run', () => {
    expect(scorer.score(context(10, 2))).toBeNull();
  });

  describe('the specification bands', () => {
    it('gives full marks when nothing needs deleting', () => {
      expect(scorer.score(withBranches(0))?.fraction).toBe(1);
    });

    it('gives 7 of 15 for one or two', () => {
      expect(scorer.score(withBranches(1))?.fraction).toBeCloseTo(7 / 15);
      expect(scorer.score(withBranches(2))?.fraction).toBeCloseTo(7 / 15);
    });

    it('gives 4 of 15 for three to five', () => {
      expect(scorer.score(withBranches(3))?.fraction).toBeCloseTo(4 / 15);
      expect(scorer.score(withBranches(5))?.fraction).toBeCloseTo(4 / 15);
    });

    it('gives nothing beyond five', () => {
      expect(scorer.score(withBranches(6))?.fraction).toBe(0);
      expect(scorer.score(withBranches(40))?.fraction).toBe(0);
    });

    /**
     * The substantive change from the ratio this replaced. Branch hygiene
     * scored the *share* of branches touched recently, so 1 stale branch out
     * of 20 scored 0.95 while 1 out of 2 scored 0.5 -- the same single branch
     * needing the same single deletion.
     */
    it('counts branches rather than scoring a share of them', () => {
      const fewBranches = scorer.score(withBranches(1, 0, 2));
      const manyBranches = scorer.score(withBranches(1, 0, 20));

      expect(fewBranches?.fraction).toBe(manyBranches?.fraction);
    });
  });

  describe('exemptions', () => {
    /**
     * Roughly 750 of the estate's 2,699 stranded commits sit on branches that
     * are long-lived by design and that nobody should delete. Counting them
     * would tell twenty-odd teams to destroy their release process.
     */
    it('does not count a branch somebody has exempted', () => {
      expect(scorer.score(withBranches(0, 4))?.fraction).toBe(1);
    });

    it('says how many it forgave, so the counts reconcile', () => {
      expect(scorer.score(withBranches(0, 4))?.detail).toBe(
        'None need deleting (4 exempt as deliberate)',
      );
      expect(scorer.score(withBranches(2, 3))?.detail).toBe(
        '2 branches with no commit in 90 days, 3 exempt from the count as deliberate',
      );
    });

    it('stays quiet about exemptions when there are none', () => {
      expect(scorer.score(withBranches(0))?.detail).toBe('None need deleting');
      expect(scorer.score(withBranches(2))?.detail).toBe(
        '2 branches with no commit in 90 days',
      );
    });
  });

  /**
   * Found in the browser, not by reasoning: with the specification's rule name
   * as the title, the scorecard row read "No stale branches -- 5 branches with
   * no commit in 90 days". A row labels the measurement; only the rule heading
   * asserts the desired state.
   */
  it('is titled after the measurement, not after the rule', () => {
    expect(scorer.title).toBe('Stale branches');
    expect(scorer.score(withBranches(5))?.detail).not.toContain('No stale');
  });

  /**
   * This reverses the branch-hygiene reasoning, which called a repository with
   * no branches unmeasurable on the grounds that full marks would flatter
   * something empty. That was a guard against dividing by zero in a ratio;
   * with a count there is no division, and "nothing needs deleting" is true.
   */
  it('gives full marks to a repository with only its default branch', () => {
    const outcome = scorer.score({
      ...context(10, 2),
      branches: {
        total: 1,
        active: 1,
        stale: 0,
        staleActionable: 0,
        staleExempt: 0,
        lastCommitAt: NOW,
      },
    });

    expect(outcome?.fraction).toBe(1);
  });

  it('singularises a single branch', () => {
    expect(scorer.score(withBranches(1))?.detail).toBe(
      '1 branch with no commit in 90 days',
    );
  });

  it('names the config key that would exempt a branch', () => {
    expect(scorer.score(withBranches(4))?.remediation).toContain(
      'fleet.scoring.metrics.staleBranches.exempt',
    );
  });

  it('drops the remediation at full marks', () => {
    expect(scorer.score(withBranches(0))?.remediation).toBeUndefined();
  });
});

describe('codeReviewCompletedScorer', () => {
  const scorer = codeReviewCompletedScorer();

  /** `peerApproved` defaults to `approved`, i.e. no self-approvals. */
  const withReviews = (approved: number, merged: number, peer = approved) => ({
    ...context(10, 2),
    reviews: { merged, approved, peerApproved: peer, open: 0 },
  });

  it('cannot measure a repository with no merged pull requests', () => {
    expect(scorer.score(context(10, 2))).toBeNull();
    expect(scorer.score(withReviews(0, 0))).toBeNull();
  });

  describe('the specification bands', () => {
    it('gives full marks at 90% or better', () => {
      expect(scorer.score(withReviews(9, 10))?.fraction).toBe(1);
      expect(scorer.score(withReviews(10, 10))?.fraction).toBe(1);
    });

    it('gives 7 of 15 between 70% and 89%', () => {
      expect(scorer.score(withReviews(7, 10))?.fraction).toBeCloseTo(7 / 15);
      // 89% is the top of the band, not the bottom of the one above.
      expect(scorer.score(withReviews(89, 100))?.fraction).toBeCloseTo(7 / 15);
    });

    it('gives nothing below 70%', () => {
      expect(scorer.score(withReviews(69, 100))?.fraction).toBe(0);
      expect(scorer.score(withReviews(0, 5))?.fraction).toBe(0);
    });

    /**
     * The change from linear to banded, pinned. A repository at 40% used to
     * earn 0.4 of the weight and now earns none of it, which is the sharper
     * incentive the specification asks for.
     */
    it('is banded, not graded', () => {
      expect(scorer.score(withReviews(4, 10))?.fraction).not.toBeCloseTo(0.4);
      expect(scorer.score(withReviews(4, 10))?.fraction).toBe(0);
    });
  });

  describe('self-approval', () => {
    /**
     * The finding this option exists for: measured over 365 merged pull
     * requests in 90 days, 265 carried an approval and only 85 carried one
     * from anybody other than the author.
     */
    it('does not count the author approving their own pull request', () => {
      const outcome = scorer.score(withReviews(10, 10, 1));

      expect(outcome?.fraction).toBe(0);
      expect(outcome?.detail).toBe(
        '1 of 10 merged PRs reviewed by somebody else in 90 days',
      );
    });

    it('names the self-approvals, because that is the gap to close', () => {
      expect(scorer.score(withReviews(10, 10, 1))?.remediation).toContain(
        '9 more carried only the author',
      );
    });

    it('counts them when configured to, without a deploy', () => {
      const lenient = codeReviewCompletedScorer({ countSelfApprovals: true });
      const outcome = lenient.score(withReviews(10, 10, 1));

      expect(outcome?.fraction).toBe(1);
      expect(outcome?.detail).toBe('10 of 10 merged PRs approved in 90 days');
    });

    it('says nothing about them when there were none', () => {
      expect(scorer.score(withReviews(7, 10, 7))?.remediation).not.toContain(
        'self',
      );
    });

    it('says nothing about them when they are being counted', () => {
      const lenient = codeReviewCompletedScorer({ countSelfApprovals: true });
      expect(lenient.score(withReviews(7, 10, 1))?.remediation).not.toContain(
        'self',
      );
    });
  });

  it('explains the ratio', () => {
    expect(scorer.score(withReviews(4, 10))?.detail).toBe(
      '4 of 10 merged PRs reviewed by somebody else in 90 days',
    );
  });

  it('singularises a single pull request', () => {
    expect(scorer.score(withReviews(1, 1))?.detail).toBe(
      '1 of 1 merged PR reviewed by somebody else in 90 days',
    );
  });

  it('drops the remediation at full marks', () => {
    expect(scorer.score(withReviews(10, 10))?.remediation).toBeUndefined();
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
      bands: DEFAULT_BANDS,
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
      bands: DEFAULT_BANDS,
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
    // The recency scorers deliberately stay silent for a repository with no
    // commits at all: "commit more" answers neither the scaffold case nor the
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
        bands: DEFAULT_BANDS,
        scorers: [{ scorer: unmeasurable, weight: 10 }],
      }).score(context(10, 2)).breakdown[0].remediation,
    ).toBeUndefined();
  });
});

describe('scorers supply their own remediation', () => {
  it('mainBranchCurrent quotes the configured threshold, not a hardcoded one', () => {
    // The whole reason remediation lives in the scorer: the ladder is config,
    // and a frontend lookup table would drift the moment it was tuned.
    const outcome = mainBranchCurrentScorer({
      bands: [{ withinDays: 14, points: 20 }],
    }).score({
      ...context(5, 1),
      activity: {
        commits: 5,
        authors: 1,
        lastCommitAt: new Date(NOW.getTime() - 40 * 86_400_000),
      },
    });

    expect(outcome?.remediation).toContain('every 14 days');
    expect(outcome?.remediation).toContain('40 days ago');
  });

  it('activeDevelopment says nothing to a repository with no commits', () => {
    expect(
      activeDevelopmentScorer().score({
        ...context(0, 0),
        activity: { commits: 0, authors: 0, lastCommitAt: null },
      })?.remediation,
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
    // Pinned because the total has drifted repeatedly: adding the ownership
    // metric took it to 100, adding pull-request discipline took it to 110,
    // dropping the security scan brought it back, and the rule rewrite had to
    // preserve it at every step. A silent drift rescales every score on the
    // estate.
    //
    // These are the specification's own figures at last, in the order its
    // tables list them: main branch up to date, no stale branches, changes
    // only through pull requests, pull request reviews, pull request size,
    // active development, README.
    const registered = [20, 15, 20, 15, 10, 10, 10];

    expect(registered).toHaveLength(7);
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

  describe('the specification bands', () => {
    it('gives 7 of 20 between 95% and 99%', () => {
      // 49 of 50 is 98%. Under the linear scoring this replaced it earned
      // 0.98 of the weight; the rule is "no direct commits", so nearly
      // complying is now most of the way to nothing.
      const slip = scorer.score(
        withPolicy(policy({ mainline: 50, viaPullRequest: 49, direct: 1 })),
      );

      expect(slip!.fraction).toBeCloseTo(7 / 20);
      expect(slip!.fraction).not.toBeCloseTo(0.98);
    });

    it('gives 3 of 20 between 80% and 94%', () => {
      const outcome = scorer.score(
        withPolicy(policy({ mainline: 10, viaPullRequest: 9, direct: 1 })),
      );

      expect(outcome!.fraction).toBeCloseTo(3 / 20);
    });

    it('gives nothing below 80%', () => {
      const none = scorer.score(
        withPolicy(policy({ mainline: 11, viaPullRequest: 0, direct: 11 })),
      );
      const most = scorer.score(
        withPolicy(policy({ mainline: 10, viaPullRequest: 7, direct: 3 })),
      );

      expect(none!.fraction).toBe(0);
      expect(most!.fraction).toBe(0);
    });

    /**
     * Full marks are decided by an integer comparison, not by whether the
     * division rounds to 1. A repository one commit short of perfect must land
     * in the band below rather than float up to it.
     */
    it('reserves full marks for exactly 100%', () => {
      const perfect = scorer.score(
        withPolicy(policy({ mainline: 1000, viaPullRequest: 1000 })),
      );
      const nearly = scorer.score(
        withPolicy(policy({ mainline: 1000, viaPullRequest: 999, direct: 1 })),
      );

      expect(perfect!.fraction).toBe(1);
      expect(nearly!.fraction).toBeCloseTo(7 / 20);
    });
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

    // 50% is below the lowest band, so it scores nothing -- but it must be
    // scored, not treated as unmeasurable.
    expect(outcome?.fraction).toBe(0);
    expect(outcome?.detail).toContain('merged from a branch');
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

describe('pullRequestSizeScorer', () => {
  const scorer = pullRequestSizeScorer();
  const withSize = (size: any) => ({ ...context(10, 2), size });
  const sized = (
    averageChangedLines: number,
    extra: Record<string, unknown> = {},
  ) => ({
    measured: 4,
    pending: 0,
    averageChangedLines,
    medianChangedLines: averageChangedLines,
    largestChangedLines: averageChangedLines,
    imports: 0,
    ...extra,
  });

  it('cannot measure a repository with no merged pull requests', () => {
    expect(scorer.score(withSize(undefined))).toBeNull();
  });

  /**
   * The portal's own gap, not the repository's. Scoring it as small would
   * hand out full marks for work nothing has looked at.
   */
  it('cannot measure pull requests whose diffstat has not been fetched', () => {
    expect(
      scorer.score(withSize({ measured: 0, pending: 12, imports: 0 })),
    ).toBeNull();
  });

  describe('the specification bands', () => {
    it('gives full marks under 400 changed lines', () => {
      expect(scorer.score(withSize(sized(399)))?.fraction).toBe(1);
      expect(scorer.score(withSize(sized(10)))?.fraction).toBe(1);
    });

    it('gives 3 of 10 between 400 and 1,000', () => {
      expect(scorer.score(withSize(sized(400)))?.fraction).toBeCloseTo(3 / 10);
      expect(scorer.score(withSize(sized(1000)))?.fraction).toBeCloseTo(3 / 10);
    });

    /**
     * **One, not zero** -- the only band on the whole scorecard that pays
     * something for a bad result. A team merging 5,000-line pull requests is
     * at least merging pull requests, which is more than a repository with
     * none can say, and the specification's table reflects that.
     */
    it('gives 1 of 10 above 1,000, never nothing', () => {
      expect(scorer.score(withSize(sized(1001)))?.fraction).toBeCloseTo(1 / 10);
      expect(scorer.score(withSize(sized(31856)))?.fraction).toBeCloseTo(
        1 / 10,
      );
      expect(scorer.score(withSize(sized(31856)))?.fraction).not.toBe(0);
    });
  });

  it('explains the figure it scored', () => {
    expect(scorer.score(withSize(sized(250)))?.detail).toBe(
      '250 changed lines on average across 4 merged PRs in 90 days',
    );
  });

  /**
   * Open decision 11. The specification's table says "Average PR Size", so the
   * mean is the default and the median is config -- switching deviates from
   * the document and is a product decision.
   *
   * Measured 2026-09-10 across the 44 repositories with merged pull requests:
   * the mean puts **25 of them at 1 of 10** and the median 13, and the
   * difference is release mechanics rather than review burden. `oxp-backend`
   * merged 66 pull requests typically 240 lines long and scores 1 of 10 on the
   * mean because one promotion moved 35,028 lines.
   */
  describe('which statistic is scored', () => {
    const skewed = sized(2730, { medianChangedLines: 3, measured: 12 });

    it('scores the mean by default, as the specification names it', () => {
      expect(scorer.score(withSize(skewed))?.fraction).toBeCloseTo(1 / 10);
    });

    it('scores the median when configured to', () => {
      const byMedian = pullRequestSizeScorer({ statistic: 'median' });

      expect(byMedian.score(withSize(skewed))?.fraction).toBe(1);
    });

    it('names the statistic it actually scored', () => {
      const byMedian = pullRequestSizeScorer({ statistic: 'median' });

      expect(byMedian.score(withSize(skewed))?.detail).toBe(
        '3 changed lines typically across 12 merged PRs in 90 days, on average 2730',
      );
    });

    it('drops the remediation when the median clears the band', () => {
      const byMedian = pullRequestSizeScorer({ statistic: 'median' });

      expect(byMedian.score(withSize(skewed))?.remediation).toBeUndefined();
    });

    it('shows no contrast when the two broadly agree', () => {
      const even = sized(300, { medianChangedLines: 280 });
      const byMedian = pullRequestSizeScorer({ statistic: 'median' });

      expect(byMedian.score(withSize(even))?.detail).not.toContain(
        'on average',
      );
    });
  });

  it('singularises a single pull request', () => {
    expect(
      scorer.score(withSize(sized(250, { measured: 1 })))?.detail,
    ).toContain('across 1 merged PR in 90 days');
  });

  /**
   * The mean is the scored statistic and a poor description of this estate:
   * one 31,856-line initial import drags it past 1,000 however disciplined
   * every later change was. The median is shown beside it when they disagree
   * materially, so the number is not read as a verdict on the team.
   */
  it('names the median when it disagrees with the mean', () => {
    const outcome = scorer.score(
      withSize(sized(4000, { medianChangedLines: 120 })),
    );

    expect(outcome?.detail).toContain('typically 120');
  });

  it('stays quiet about the median when the two broadly agree', () => {
    expect(
      scorer.score(withSize(sized(300, { medianChangedLines: 280 })))?.detail,
    ).not.toContain('typically');
  });

  it('says when some pull requests are still unmeasured', () => {
    expect(
      scorer.score(withSize(sized(300, { pending: 7 })))?.detail,
    ).toContain('7 not yet measured');
  });

  it('names imports, which no review could have made smaller', () => {
    const outcome = scorer.score(
      withSize(sized(4000, { imports: 2, largestChangedLines: 31856 })),
    );

    expect(outcome?.remediation).toContain('31856 lines');
    expect(outcome?.remediation).toContain('2 of them are an import');
  });

  it('drops the remediation at full marks', () => {
    expect(scorer.score(withSize(sized(100)))?.remediation).toBeUndefined();
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
      bands: DEFAULT_BANDS,
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
