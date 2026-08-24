/**
 * Derives a repository's technology stack from what is at its root.
 *
 * Two tiers, deliberately. The file listing alone identifies the ecosystem and
 * costs nothing -- it is already stored from the detail sync. Manifest contents
 * add framework detail and cost one request each, so they are optional.
 *
 * Nothing here guesses beyond the evidence: a repository with no recognised
 * manifest gets an empty stack rather than a plausible-looking invention.
 */

/** Ecosystem markers, keyed by the root file that proves them. */
const ECOSYSTEM_BY_FILE: Array<[RegExp, string]> = [
  [/^package\.json$/i, 'Node.js'],
  [/^(requirements\.txt|pyproject\.toml|setup\.py|pipfile)$/i, 'Python'],
  [/^go\.mod$/i, 'Go'],
  [/^(pom\.xml|build\.gradle(\.kts)?)$/i, 'Java'],
  [/^composer\.json$/i, 'PHP'],
  [/^gemfile$/i, 'Ruby'],
  [/^cargo\.toml$/i, 'Rust'],
  [/\.(csproj|sln|fsproj)$/i, '.NET'],
  [/^(dockerfile|containerfile)$/i, 'Docker'],
  [/^(template\.ya?ml|samconfig\.toml)$/i, 'AWS SAM'],
  [/^serverless\.ya?ml$/i, 'Serverless Framework'],
  [/^(terraform\.tf|main\.tf)$/i, 'Terraform'],
  [/^(docker-compose\.ya?ml|compose\.ya?ml)$/i, 'Docker Compose'],
];

/**
 * The language a repository is mostly written in, inferred from its ecosystem.
 *
 * Bitbucket reports no language for 94% of this estate, so this is the only
 * source available. Ordered by specificity: an ecosystem marker beats nothing,
 * and TypeScript beats JavaScript when the dependency is present.
 */
const LANGUAGE_BY_ECOSYSTEM: Record<string, string> = {
  'Node.js': 'JavaScript',
  Python: 'Python',
  Go: 'Go',
  Java: 'Java',
  PHP: 'PHP',
  Ruby: 'Ruby',
  Rust: 'Rust',
  '.NET': 'C#',
};

/** Frameworks recognisable from a package.json dependency name. */
const NODE_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^typescript$/, 'TypeScript'],
  [/^react$/, 'React'],
  [/^vue$/, 'Vue'],
  [/^@angular\/core$/, 'Angular'],
  [/^svelte$/, 'Svelte'],
  [/^next$/, 'Next.js'],
  [/^nuxt$/, 'Nuxt'],
  [/^express$/, 'Express'],
  [/^@nestjs\/core$/, 'NestJS'],
  [/^fastify$/, 'Fastify'],
  [/^vite$/, 'Vite'],
  [/^webpack$/, 'Webpack'],
  [/^jest$/, 'Jest'],
  [/^@aws-sdk\/client-/, 'AWS SDK'],
  [/^aws-sdk$/, 'AWS SDK'],
];

/** Frameworks recognisable from a Python requirement line. */
const PYTHON_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^fastapi\b/i, 'FastAPI'],
  [/^flask\b/i, 'Flask'],
  [/^django\b/i, 'Django'],
  [/^boto3\b/i, 'AWS SDK'],
  [/^pandas\b/i, 'pandas'],
  [/^sqlalchemy\b/i, 'SQLAlchemy'],
  [/^pytest\b/i, 'pytest'],
  [/^snowflake[-_]/i, 'Snowflake'],
];

export interface TechStackAnalysis {
  /** Distinct labels, ecosystems first then frameworks, each appearing once. */
  stack: string[];
  /** Inferred primary language, or undefined when nothing indicates one. */
  language?: string;
  /** Root files that contributed, so a result can be explained. */
  evidence: string[];
}

/** Manifest paths worth fetching for a given root listing. */
export function manifestsWorthReading(rootFiles: string[]): string[] {
  return rootFiles.filter(f =>
    /^(package\.json|requirements\.txt|pyproject\.toml)$/i.test(f),
  );
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function nodeFrameworks(packageJson: string): string[] {
  let parsed: any;
  try {
    parsed = JSON.parse(packageJson);
  } catch {
    // A malformed manifest tells us nothing; it is not an error worth raising.
    return [];
  }

  const names = Object.keys({
    ...(parsed?.dependencies ?? {}),
    ...(parsed?.devDependencies ?? {}),
  });

  return NODE_FRAMEWORKS.filter(([pattern]) =>
    names.some(name => pattern.test(name)),
  ).map(([, label]) => label);
}

function pythonFrameworks(requirements: string): string[] {
  const lines = requirements
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'));

  return PYTHON_FRAMEWORKS.filter(([pattern]) =>
    lines.some(line => pattern.test(line)),
  ).map(([, label]) => label);
}

/**
 * Analyses a repository.
 *
 * `manifests` maps a root file name to its contents. Omitting it yields the
 * ecosystem-only result, which is what the stored file listing supports on its
 * own.
 */
export function analyseTechStack(
  rootFiles: string[],
  manifests: Record<string, string> = {},
): TechStackAnalysis {
  const evidence: string[] = [];
  const ecosystems: string[] = [];

  for (const file of rootFiles) {
    for (const [pattern, label] of ECOSYSTEM_BY_FILE) {
      if (pattern.test(file)) {
        ecosystems.push(label);
        evidence.push(file);
      }
    }
  }

  const frameworks: string[] = [];
  for (const [file, contents] of Object.entries(manifests)) {
    if (/^package\.json$/i.test(file)) {
      frameworks.push(...nodeFrameworks(contents));
    } else if (/^(requirements\.txt|pyproject\.toml)$/i.test(file)) {
      frameworks.push(...pythonFrameworks(contents));
    }
  }

  const stack = dedupe([...ecosystems, ...frameworks]);

  // TypeScript supersedes the JavaScript implied by package.json alone.
  let language: string | undefined;
  for (const ecosystem of ecosystems) {
    const candidate = LANGUAGE_BY_ECOSYSTEM[ecosystem];
    if (candidate) {
      language = candidate;
      break;
    }
  }
  if (language === 'JavaScript' && stack.includes('TypeScript')) {
    language = 'TypeScript';
  }

  return { stack, language, evidence: dedupe(evidence) };
}
