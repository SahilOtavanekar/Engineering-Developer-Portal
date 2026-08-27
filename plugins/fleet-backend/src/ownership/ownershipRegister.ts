import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';

/** One person the register can name. */
export interface RegisteredPerson {
  name: string;
  email: string;
}

/**
 * Confirmed ownership, as supplied by config.
 *
 * Parsed once at startup into plain maps rather than being read through the
 * `Config` API per repository: the resolver is asked about 95 repositories on
 * every pass, and a `Config` lookup per candidate would re-walk the tree each
 * time for data that cannot change without a restart.
 */
export interface OwnershipRegister {
  /** Short owner name, as the register writes it, to a real identity. */
  people: Map<string, RegisteredPerson>;
  /** Repository slug to owner names, strongest first. */
  repositories: Map<string, string[]>;
}

export const EMPTY_OWNERSHIP_REGISTER: OwnershipRegister = {
  people: new Map(),
  repositories: new Map(),
};

/**
 * Reads `fleet.ownership.register`.
 *
 * Tolerant by design: a malformed or absent register must leave the portal
 * running on its derived resolvers rather than failing startup. Ownership is
 * reference data maintained by hand, so a typo in it is likely and must not be
 * able to take the backend down. Anything skipped is logged, because silently
 * dropping an owner would look identical to a repository nobody has claimed.
 */
export function readOwnershipRegister(
  config: Config | undefined,
  logger?: LoggerService,
): OwnershipRegister {
  if (!config) return EMPTY_OWNERSHIP_REGISTER;

  const people = new Map<string, RegisteredPerson>();
  const peopleConfig = config.getOptionalConfig('people');
  for (const key of peopleConfig?.keys() ?? []) {
    const entry = peopleConfig!.getOptionalConfig(key);
    const name = entry?.getOptionalString('name');
    const email = entry?.getOptionalString('email');
    if (!name || !email) {
      logger?.warn(
        `Ownership register: person '${key}' is missing a name or email and ` +
          `will be ignored`,
      );
      continue;
    }
    people.set(key, { name, email });
  }

  const repositories = new Map<string, string[]>();
  const reposConfig = config.getOptionalConfig('repositories');
  for (const slug of reposConfig?.keys() ?? []) {
    let owners: string[];
    try {
      owners = reposConfig!.getStringArray(slug);
    } catch (error) {
      logger?.warn(
        `Ownership register: owners for '${slug}' are not a list of names ` +
          `and will be ignored: ${(error as Error).message}`,
      );
      continue;
    }
    // An unknown name is dropped rather than guessed at. The register names
    // people by first name, and this estate contains more than one Shubham.
    const known = owners.filter(name => people.has(name));
    for (const name of owners.filter(n => !people.has(n))) {
      logger?.warn(
        `Ownership register: '${slug}' names owner '${name}', which has no ` +
          `entry under people; no candidate will be produced for it`,
      );
    }
    if (known.length > 0) repositories.set(slug, known);
  }

  return { people, repositories };
}
