import type { RepositoryScoreSummary, ScoreBreakdownEntry } from './types';
import {
  deriveProblems,
  describeDormancy,
  shouldHighlightProblems,
} from './problems';

const entry = (
  id: string,
  title: string,
  weight: number,
  points: number | undefined,
  detail = 'detail',
): ScoreBreakdownEntry => ({
  id,
  title,
  weight,
  ...(points === undefined ? {} : { points }),
  detail,
  available: points !== undefined,
});

const score = (
  breakdown: ScoreBreakdownEntry[],
  band = 'critical',
): RepositoryScoreSummary => ({
  total: 30,
  band,
  availableWeight: breakdown
    .filter(b => b.available)
    .reduce((a, b) => a + b.weight, 0),
  nominalWeight: 100,
  computedAt: '2026-08-27T08:00:00.000Z',
  breakdown,
});

/** The activity metric at zero is what marks a repository dormant. */
const dormantActivity = [
  entry('active-commits', 'Active commits', 20, 0),
  entry('active-contributors', 'Active contributors', 10, 0),
  entry('branch-hygiene', 'Branch hygiene', 10, 0),
];

describe('deriveProblems', () => {
  it('returns nothing for a repository that has never been scored', () => {
    expect(deriveProblems(undefined)).toEqual({
      actionable: [],
      unmeasured: [],
      lostPoints: 0,
    });
  });

  it('ranks problems by points lost, not by registration order', () => {
    // A 20-weight metric at zero outranks a 10-weight one, whatever order the
    // engine happened to register them in.
    const problems = deriveProblems(
      score([
        entry('readme-available', 'README available', 10, 0),
        entry('pipeline-passing', 'Pipeline passing', 20, 4),
        entry('active-commits', 'Active commits', 20, 16),
      ]),
    );

    expect(problems.actionable.map(p => p.title)).toEqual([
      'Pipeline not passing',
      'README not available',
      'Not enough commits',
    ]);
    expect(problems.actionable[0].lost).toBe(16);
    expect(problems.lostPoints).toBe(30);
  });

  it('leaves a metric scoring full marks out entirely', () => {
    const problems = deriveProblems(
      score([
        entry('readme-available', 'README available', 10, 10),
        entry('owner-assigned', 'Owner assigned', 10, 0),
      ]),
    );

    expect(problems.actionable.map(p => p.id)).toEqual(['owner-assigned']);
  });

  it('keeps an unmeasurable metric out of the problems', () => {
    // 55 repositories cannot be judged on code review because they have no
    // merged pull requests. That is not a failing.
    const problems = deriveProblems(
      score([
        entry('owner-assigned', 'Owner assigned', 10, 0),
        entry('code-review-completed', 'Code review completed', 10, undefined),
      ]),
    );

    expect(problems.actionable.map(p => p.id)).toEqual(['owner-assigned']);
    expect(problems.unmeasured.map(p => p.id)).toEqual([
      'code-review-completed',
    ]);
    expect(problems.lostPoints).toBe(10);
  });

  describe('problem phrasing', () => {
    // A chip reading "Pipeline passing (37)" looks like 37 repositories whose
    // pipelines pass. It means the opposite, which is why the wording changed.
    it('names every registered metric as the problem it is', () => {
      const problems = deriveProblems(
        score([
          // Partial marks, not zero: a zero here marks the repository dormant,
          // which deliberately folds all three activity metrics away.
          entry('active-commits', 'Active commits', 20, 5),
          entry('active-contributors', 'Active contributors', 10, 2),
          entry('branch-hygiene', 'Branch hygiene', 10, 3),
          entry('code-review-completed', 'Code review completed', 10, 0),
          entry('owner-assigned', 'Owner assigned', 10, 0),
          entry('pipeline-passing', 'Pipeline passing', 20, 0),
          entry('pull-request-discipline', 'Changes land through PRs', 10, 0),
          entry('readme-available', 'README available', 10, 0),
        ]),
      );

      // Sorted by points lost, so the order is not the order given above.
      expect(
        Object.fromEntries(problems.actionable.map(p => [p.id, p.title])),
      ).toEqual({
        'active-commits': 'Not enough commits',
        'active-contributors': 'Not enough contributors',
        'branch-hygiene': 'Stale branches',
        'code-review-completed': 'Code review not completed',
        'owner-assigned': 'Owner not assigned',
        'pipeline-passing': 'Pipeline not passing',
        'pull-request-discipline': 'Changes bypassing pull requests',
        'readme-available': 'README not available',
      });
    });

    it('leaves an unmeasured metric neutrally titled', () => {
      // The asymmetry that matters: 55 repositories cannot be judged on code
      // review, and not one of them has failed to review anything. Calling
      // that "Code review not completed" would assert a failure that the
      // portal has no evidence for.
      const problems = deriveProblems(
        score([
          entry(
            'code-review-completed',
            'Code review completed',
            10,
            undefined,
          ),
        ]),
      );

      expect(problems.unmeasured[0].title).toBe('Code review completed');
      expect(problems.actionable).toEqual([]);
    });

    it('falls back to the scorer title for a metric it does not know', () => {
      // A scorer registered later still produces a named problem rather than a
      // blank chip.
      const problems = deriveProblems(
        score([entry('security-scan', 'Security scan passing', 10, 0)]),
      );

      expect(problems.actionable[0].title).toBe('Security scan passing');
    });
  });

  describe('dormancy', () => {
    it('collapses the activity metrics into one statement', () => {
      // Commits, contributors and branch hygiene are the same fact three times
      // over when nothing landed. Reporting all three would be noise on 48 of
      // this estate's repositories.
      const problems = deriveProblems(score(dormantActivity), {
        commits: 4,
        authors: 1,
      });

      expect(problems.actionable).toEqual([]);
      expect(problems.dormancy?.kind).toBe('never-started');
    });

    it('still reports the independent gaps alongside dormancy', () => {
      const problems = deriveProblems(
        score([
          ...dormantActivity,
          entry('readme-available', 'README available', 10, 0),
          entry('owner-assigned', 'Owner assigned', 10, 0),
        ]),
        { commits: 4, authors: 1 },
      );

      expect(problems.actionable.map(p => p.id)).toEqual([
        'owner-assigned',
        'readme-available',
      ]);
      expect(problems.dormancy).toBeDefined();
    });

    it('calls a repository with real history abandoned, not never-started', () => {
      // portal-ui has 276 lifetime commits and nothing recent. That is a very
      // different conversation from a two-commit scaffold.
      const problems = deriveProblems(score(dormantActivity), {
        commits: 276,
        authors: 6,
        lastCommitAt: '2025-10-30T00:00:00.000Z',
      });

      expect(problems.dormancy).toMatchObject({
        kind: 'abandoned',
        lifetimeCommits: 276,
      });
    });

    it('treats a repository at the never-started boundary as never started', () => {
      const problems = deriveProblems(score(dormantActivity), {
        commits: 10,
        authors: 1,
      });

      expect(problems.dormancy?.kind).toBe('never-started');
    });

    it('assumes never-started when lifetime facts have not been ingested', () => {
      // Absent lifetime data must not promote a scaffold to "abandoned", which
      // is the more alarming of the two.
      const problems = deriveProblems(score(dormantActivity));

      expect(problems.dormancy?.kind).toBe('never-started');
    });

    it('reports no dormancy for a repository that is committing', () => {
      const problems = deriveProblems(
        score([
          entry('active-commits', 'Active commits', 20, 16),
          entry('readme-available', 'README available', 10, 0),
        ]),
        { commits: 300, authors: 4 },
      );

      expect(problems.dormancy).toBeUndefined();
      expect(problems.actionable.map(p => p.id)).toEqual([
        'readme-available',
        'active-commits',
      ]);
    });

    it('does not claim dormancy when activity could not be measured at all', () => {
      const problems = deriveProblems(
        score([entry('active-commits', 'Active commits', 20, undefined)]),
      );

      expect(problems.dormancy).toBeUndefined();
    });
  });
});

describe('shouldHighlightProblems', () => {
  it('leads with problems below healthy', () => {
    expect(shouldHighlightProblems(score([], 'critical'))).toBe(true);
    expect(shouldHighlightProblems(score([], 'needs-attention'))).toBe(true);
  });

  it('does not banner a healthy repository over one small gap', () => {
    // Putting a warning on 36 healthy repositories is how a warning gets
    // trained out of people.
    expect(shouldHighlightProblems(score([], 'healthy'))).toBe(false);
  });

  it('stays quiet for a repository with no score at all', () => {
    expect(shouldHighlightProblems(undefined)).toBe(false);
  });
});

describe('describeDormancy', () => {
  it('says plainly that a scaffold is not a decaying service', () => {
    const text = describeDormancy(
      { kind: 'never-started', lifetimeCommits: 2 },
      90,
    );

    expect(text).toContain('2 commits');
    expect(text).toContain('Not a decaying service');
  });

  it('uses the singular for a one-commit repository', () => {
    expect(
      describeDormancy({ kind: 'never-started', lifetimeCommits: 1 }, 90),
    ).toContain('1 commit in');
  });

  it('leads with the history when a repository was abandoned', () => {
    const text = describeDormancy(
      { kind: 'abandoned', lifetimeCommits: 276 },
      90,
    );

    expect(text).toContain('Abandoned');
    expect(text).toContain('276 commits');
    expect(text).toContain('90 days');
  });

  it('copes with no lifetime count', () => {
    expect(describeDormancy({ kind: 'abandoned' }, 30)).toContain('30 days');
    expect(describeDormancy({ kind: 'never-started' }, 30)).toContain(
      'Never really developed',
    );
  });
});
