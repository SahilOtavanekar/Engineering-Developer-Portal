/**
 * What kind of thing a repository is, and how far along it is.
 *
 * Section 3 of the requirements asks for both. The entity provider has shipped
 * `type: 'service'` and `lifecycle: 'unknown'` for every repository since step
 * 5, which for a library or a front end is simply wrong -- and wrong on the two
 * fields a reader looks at first.
 *
 * The rule followed throughout: claim only what the evidence carries, and say
 * `unknown` otherwise. An honest gap is correctable; a confident mislabel is
 * believed until it causes a problem.
 */

/** Backstage's conventional component types, minus the ones we cannot justify. */
export type DerivedType = 'service' | 'website' | 'unknown';

/** Backstage's conventional lifecycles, minus `deprecated`. */
export type DerivedLifecycle = 'production' | 'experimental' | 'unknown';

export interface RepositoryClassification {
  type: DerivedType;
  lifecycle: DerivedLifecycle;
}

export interface ClassificationInput {
  /** Frameworks and tools from {@link analyseTechStack}. */
  techStack: string[];
  /** Whether the repository has any pipeline runs at all. */
  hasPipelineRuns: boolean;
  /** Bitbucket environment types with a completed deployment. */
  environmentTypes: string[];
}

/**
 * A user-facing application is a website even when it ships in a container.
 * Checked before the service markers for exactly that reason: most front ends
 * here also carry Docker, and letting Docker win would classify every one of
 * them as a service.
 */
const FRONTEND_MARKERS = new Set([
  'React',
  'Angular',
  'Vue',
  'Next.js',
  'Svelte',
  'Vite',
]);

/**
 * Markers that something is meant to run as a deployed process.
 *
 * `AWS SDK` is absent on purpose -- a one-off script uses it too, and it would
 * pull scripts into `service`.
 */
const SERVICE_MARKERS = new Set([
  'Docker',
  'Docker Compose',
  'AWS SAM',
  'Express',
  'FastAPI',
  'Fastify',
  'NestJS',
  'Spring Boot',
]);

function classifyType(input: ClassificationInput): DerivedType {
  const stack = new Set(input.techStack);

  for (const marker of stack) {
    if (FRONTEND_MARKERS.has(marker)) return 'website';
  }
  for (const marker of stack) {
    if (SERVICE_MARKERS.has(marker)) return 'service';
  }
  // A repository Bitbucket has recorded a deployment for is a deployed thing,
  // whatever its manifests do or do not say.
  if (input.environmentTypes.length > 0) return 'service';

  // Left over: package manifests with no framework, no container and no
  // deployment. A library, a script, or something abandoned -- and nothing here
  // separates them.
  return 'unknown';
}

function classifyLifecycle(input: ClassificationInput): DerivedLifecycle {
  if (input.environmentTypes.includes('Production')) return 'production';
  // Built but never seen in production. `experimental` is Backstage's word for
  // it and is the honest reading: something is being integrated, and nothing
  // says it is live.
  //
  // A deployment record counts on its own, without pipeline runs: Bitbucket
  // cannot record one without a pipeline, but only the 20 most recent runs are
  // retained, so a repository that deployed to staging months ago and has been
  // quiet since has the deployment and no runs left.
  if (input.hasPipelineRuns || input.environmentTypes.length > 0) {
    return 'experimental';
  }
  return 'unknown';
}

export function classifyRepository(
  input: ClassificationInput,
): RepositoryClassification {
  return {
    type: classifyType(input),
    lifecycle: classifyLifecycle(input),
  };
}
