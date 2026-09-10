import type { BitbucketDiffstatFile } from '../bitbucket/types';
import { DEFAULT_GENERATED_PATHS, summariseDiffstat } from './diffstat';

const file = (
  path: string | undefined,
  linesAdded: number,
  linesRemoved = 0,
  status = 'modified',
): BitbucketDiffstatFile => ({ path, linesAdded, linesRemoved, status });

describe('summariseDiffstat', () => {
  it('totals what a pull request moved', () => {
    expect(
      summariseDiffstat([file('src/a.ts', 10, 4), file('src/b.ts', 6, 1)]),
    ).toMatchObject({
      filesChanged: 2,
      linesAdded: 16,
      linesRemoved: 5,
      changedLines: 21,
      excludedLines: 0,
    });
  });

  it('reports an empty diffstat as zero rather than failing', () => {
    // A merged pull request that changed nothing exists on the live estate --
    // `oxp-backend#112` -- so this is a real answer, not a hole.
    expect(summariseDiffstat([])).toEqual({
      filesChanged: 0,
      filesAdded: 0,
      linesAdded: 0,
      linesRemoved: 0,
      changedLines: 0,
      excludedLines: 0,
    });
  });

  describe('generated and vendored paths', () => {
    /**
     * Worth real points on this estate: one `package-lock.json` was 6,813 of
     * `dai-delivery#1`'s 31,856 changed lines, and another 2,077 of
     * `daarwyn-bo-ui#1`'s 8,257 -- 21% and 25% of those diffs. Counting them
     * marks a team down for a dependency bump.
     */
    it('excludes a lockfile at any depth', () => {
      const summary = summariseDiffstat([
        file('src/a.ts', 10),
        file('package-lock.json', 6813),
        file('frontend/package-lock.json', 2077),
      ]);

      expect(summary.filesChanged).toBe(1);
      expect(summary.changedLines).toBe(10);
      expect(summary.excludedLines).toBe(8890);
    });

    it('excludes a vendored directory by path segment', () => {
      const summary = summariseDiffstat([
        file('node_modules/left-pad/index.js', 40),
        file('backend/vendor/thing.go', 100),
        file('src/dist/bundle.js', 500),
      ]);

      expect(summary.filesChanged).toBe(0);
      expect(summary.excludedLines).toBe(640);
    });

    /**
     * The matching rule is a path *segment*, not a substring. Over-excluding
     * flatters a repository, which is the worse failure for a metric meant to
     * find risk.
     */
    it('does not mistake a source file for a generated one', () => {
      const summary = summariseDiffstat([
        file('src/dist-helper.ts', 10),
        file('src/build-config.ts', 20),
        file('src/my-package-lock.json.ts', 30),
        file('vendored/thing.ts', 40),
      ]);

      expect(summary.filesChanged).toBe(4);
      expect(summary.changedLines).toBe(100);
      expect(summary.excludedLines).toBe(0);
    });

    it('counts a file it cannot name as source', () => {
      // Neither `new` nor `old` path. Rare, and assuming it is generated would
      // silently shrink a diff.
      expect(summariseDiffstat([file(undefined, 50)])).toMatchObject({
        filesChanged: 1,
        changedLines: 50,
        excludedLines: 0,
      });
    });

    it('accepts a replacement list', () => {
      const summary = summariseDiffstat(
        [file('yarn.lock', 100), file('schema.graphql', 20)],
        { generatedPaths: ['schema.graphql'] },
      );

      // The built-in list is replaced, not extended: the lockfile now counts.
      expect(summary.changedLines).toBe(100);
      expect(summary.excludedLines).toBe(20);
    });

    it('normalises a Windows-style path', () => {
      expect(
        summariseDiffstat([file('frontend\\dist\\bundle.js', 500)])
          .excludedLines,
      ).toBe(500);
    });
  });

  /**
   * The added-file share is the only field that separates an initial import
   * from a change somebody could have made smaller. `dai-delivery#1` added 157
   * of 158 files.
   */
  it('counts newly added files, excluding generated ones', () => {
    const summary = summariseDiffstat([
      file('src/a.ts', 100, 0, 'added'),
      file('src/b.ts', 100, 0, 'added'),
      file('README.md', 5, 2, 'modified'),
      file('package-lock.json', 900, 0, 'added'),
    ]);

    expect(summary.filesChanged).toBe(3);
    expect(summary.filesAdded).toBe(2);
  });

  it('lists nothing speculative among the default exclusions', () => {
    // Every entry is either machine-written or vendored. A default that
    // forgives hand-written code would silently shrink every diff.
    expect(DEFAULT_GENERATED_PATHS).toContain('package-lock.json');
    expect(DEFAULT_GENERATED_PATHS).toContain('node_modules/');
    expect(DEFAULT_GENERATED_PATHS).not.toContain('src/');
    expect(DEFAULT_GENERATED_PATHS).not.toContain('test/');
  });
});
