import {
  classifyArrivals,
  directTotal,
  summarise,
  type CommitNode,
} from './branchPolicy';

/** Newest first, as Bitbucket lists them. */
const chain = (...nodes: Array<[string, ...string[]]>): CommitNode[] =>
  nodes.map(([hash, ...parents]) => ({ hash, parents }));

describe('classifyArrivals', () => {
  it('calls a plain commit on the tip a direct commit', () => {
    const result = classifyArrivals({
      commits: chain(['c', 'b'], ['b', 'a'], ['a']),
      pullRequestMerges: [],
    });

    expect(result.map(r => r.arrival)).toEqual(['direct', 'direct', 'direct']);
  });

  it('credits a pull request whose merge commit is on the branch', () => {
    const result = classifyArrivals({
      commits: chain(['merge', 'base', 'feature'], ['base'], ['feature']),
      pullRequestMerges: ['merge'],
    });

    expect(result.find(r => r.hash === 'merge')?.arrival).toBe('pull-request');
  });

  it('does not blame a feature commit that a merge brought in', () => {
    // The distinction the whole measurement rests on: 1,168 of 1,753 commits
    // on this estate's default branches arrived this way.
    const result = classifyArrivals({
      commits: chain(['merge', 'base', 'feature'], ['base'], ['feature']),
      pullRequestMerges: ['merge'],
    });

    const feature = result.find(r => r.hash === 'feature');
    expect(feature).toMatchObject({ onMainline: false, arrival: 'merged-in' });
  });

  it('treats a squashed pull request as a pull request', () => {
    // A squash lands as a single-parent commit, shape-identical to a direct
    // one. Both merge styles are in use on this estate, so shape alone cannot
    // decide it -- only the merge hash can.
    const result = classifyArrivals({
      commits: chain(['squashed', 'base'], ['base']),
      pullRequestMerges: ['squashed'],
    });

    expect(result.find(r => r.hash === 'squashed')?.arrival).toBe(
      'pull-request',
    );
  });

  it('matches an abbreviated merge hash against a full SHA', () => {
    // Bitbucket returns merge_commit.hash abbreviated to 12 characters. Whole
    // string matching finds nothing and reports every commit as direct, which
    // is plausible enough to ship by accident.
    const full = 'a1b2c3d4e5f60123456789abcdef0123456789ab';
    const result = classifyArrivals({
      commits: chain([full, 'base'], ['base']),
      pullRequestMerges: ['a1b2c3d4e5f6'],
    });

    expect(result.find(r => r.hash === full)?.arrival).toBe('pull-request');
  });

  it('calls a merge with no pull request behind it a direct merge', () => {
    // Usually a `git pull` that merged, or a local branch merged and pushed.
    // Estate-wide there are 600 merge commits against 324 merged PRs, so this
    // is not a rare case.
    const result = classifyArrivals({
      commits: chain(['merge', 'base', 'side'], ['base'], ['side']),
      pullRequestMerges: [],
    });

    expect(result.find(r => r.hash === 'merge')?.arrival).toBe('direct-merge');
  });

  it('follows the first parent, not the second, through a merge', () => {
    const result = classifyArrivals({
      commits: chain(
        ['tip', 'merge'],
        ['merge', 'mainOld', 'sideTip'],
        ['sideTip', 'sideOld'],
        ['mainOld'],
        ['sideOld'],
      ),
      pullRequestMerges: ['merge'],
    });

    const onMainline = result
      .filter(r => r.onMainline)
      .map(r => r.hash)
      .sort();
    expect(onMainline).toEqual(['mainOld', 'merge', 'tip']);
  });

  it('survives a cycle rather than looping forever', () => {
    const result = classifyArrivals({
      commits: chain(['a', 'b'], ['b', 'a']),
      pullRequestMerges: [],
    });

    expect(result).toHaveLength(2);
  });

  it('returns nothing for a repository with no commits', () => {
    expect(classifyArrivals({ commits: [], pullRequestMerges: [] })).toEqual(
      [],
    );
  });

  it('reports only commits inside the window but still walks past it', () => {
    // The chain has to be followed through older commits to know what is on
    // the branch at all; the window bounds what gets reported.
    const commits = chain(['new', 'old'], ['old', 'ancient'], ['ancient']);
    const result = classifyArrivals({
      commits,
      pullRequestMerges: [],
      since: hash => hash === 'new',
    });

    expect(result.map(r => r.hash)).toEqual(['new']);
    expect(result[0].onMainline).toBe(true);
  });
});

describe('summarise', () => {
  it('reconciles every commit into exactly one bucket', () => {
    const classified = classifyArrivals({
      commits: chain(
        ['direct1', 'merge'],
        ['merge', 'base', 'feature'],
        ['feature', 'base'],
        ['base'],
      ),
      pullRequestMerges: ['merge'],
    });

    const s = summarise(classified);

    expect(s).toEqual({
      mainline: 3,
      viaPullRequest: 1,
      direct: 2,
      directMerge: 0,
      mergedIn: 1,
    });
    expect(s.mainline + s.mergedIn).toBe(classified.length);
  });

  it('counts both kinds of direct arrival together', () => {
    const s = summarise([
      { hash: 'a', onMainline: true, arrival: 'direct' },
      { hash: 'b', onMainline: true, arrival: 'direct-merge' },
      { hash: 'c', onMainline: true, arrival: 'pull-request' },
    ]);

    expect(directTotal(s)).toBe(2);
  });

  it('reports zero for a repository with nothing on its mainline', () => {
    expect(summarise([])).toEqual({
      mainline: 0,
      viaPullRequest: 0,
      direct: 0,
      directMerge: 0,
      mergedIn: 0,
    });
  });
});
