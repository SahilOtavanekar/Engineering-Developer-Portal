import type { BitbucketDiffstatFile } from '../bitbucket/types';

/**
 * Paths whose changed lines nobody reviews.
 *
 * The requirement says to "consider excluding generated or vendor files", and
 * on this estate that is worth real points: measured 2026-09-09, one
 * `package-lock.json` was **6,813 of `dai-delivery#1`'s 31,856 changed lines**
 * and another 2,077 of `daarwyn-bo-ui#1`'s 8,257 -- 21% and 25% of those
 * diffs. Counting them would mark a team down for a dependency bump.
 *
 * Lockfiles are matched by exact name and directories by path segment, so
 * `src/dist-helper.ts` is source while `dist/index.js` is not. Deliberately
 * conservative: everything here is either machine-written or vendored, and
 * anything ambiguous is counted as source. Over-excluding would flatter a
 * repository, which is the worse failure for a metric meant to find risk.
 */
export const DEFAULT_GENERATED_PATHS = [
  // Lockfiles: machine-written, frequently enormous, never read.
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'poetry.lock',
  'Pipfile.lock',
  'composer.lock',
  'Gemfile.lock',
  'go.sum',
  'Cargo.lock',
  // Directories: vendored or built output.
  'node_modules/',
  'vendor/',
  'dist/',
  'build/',
  '.next/',
  '__generated__/',
  'coverage/',
];

export interface DiffstatSummary {
  /** Files touched, generated paths excluded. */
  filesChanged: number;
  /** Of those, how many were newly added. */
  filesAdded: number;
  linesAdded: number;
  linesRemoved: number;
  /** Lines dropped as generated, so the figure reconciles with Bitbucket's. */
  excludedLines: number;
  /** `linesAdded + linesRemoved` -- what the specification bands. */
  changedLines: number;
}

/**
 * Splits an exclusion pattern into the two shapes the list uses.
 *
 * A trailing slash means "any path with this directory segment"; anything else
 * is an exact file name, matched at any depth. Neither is a glob: a real glob
 * engine would be a dependency and a configuration surface for a list that has
 * seventeen literal entries.
 */
function isGenerated(path: string | undefined, patterns: string[]): boolean {
  if (!path) return false;
  const normalised = path.replace(/\\/g, '/');
  const name = normalised.slice(normalised.lastIndexOf('/') + 1);

  return patterns.some(pattern => {
    if (pattern.endsWith('/')) {
      const segment = pattern.slice(0, -1);
      return normalised
        .split('/')
        .slice(0, -1)
        .some(part => part === segment);
    }
    return name === pattern;
  });
}

/**
 * Totals a pull request's diffstat, leaving out what nobody reviews.
 *
 * Pure and separate from the client on purpose: which files are generated is
 * policy, the adapter should not hold policy, and a rule about paths is far
 * easier to test against a list of names than against a mocked HTTP response.
 */
export function summariseDiffstat(
  files: BitbucketDiffstatFile[],
  options: { generatedPaths?: string[] } = {},
): DiffstatSummary {
  const patterns = options.generatedPaths ?? DEFAULT_GENERATED_PATHS;

  let filesChanged = 0;
  let filesAdded = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  let excludedLines = 0;

  for (const file of files) {
    const moved = file.linesAdded + file.linesRemoved;
    if (isGenerated(file.path, patterns)) {
      excludedLines += moved;
      continue;
    }

    filesChanged++;
    if (file.status === 'added') filesAdded++;
    linesAdded += file.linesAdded;
    linesRemoved += file.linesRemoved;
  }

  return {
    filesChanged,
    filesAdded,
    linesAdded,
    linesRemoved,
    excludedLines,
    changedLines: linesAdded + linesRemoved,
  };
}
