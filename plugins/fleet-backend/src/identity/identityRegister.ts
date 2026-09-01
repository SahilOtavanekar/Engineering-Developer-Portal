import type { Config } from '@backstage/config';
import type { LoggerService } from '@backstage/backend-plugin-api';

/** One human, and the address the portal will key them on. */
export interface RegisteredEngineer {
  /** Stable slug, safe for an entity ref or a URL. */
  key: string;
  name: string;
  /**
   * Canonical address, when they have one.
   *
   * Optional because a person can appear in the estate without ever
   * committing: `Saideep Narayan Avhad` reviews pull requests and has no
   * commits, so there is no address to key them on -- and inventing one would
   * be a guess that later attributes somebody else's commits to them. Such a
   * person resolves by name only.
   */
  email?: string;
}

export interface IdentityRegister {
  /** Everyone the register names, in declaration order. */
  people: RegisteredEngineer[];
  /** Normalised address to the person who owns it, aliases included. */
  byAddress: Map<string, RegisteredEngineer>;
  /** Normalised addresses that belong to no person at all. */
  excluded: Set<string>;
}

export const EMPTY_IDENTITY_REGISTER: IdentityRegister = {
  people: [],
  byAddress: new Map(),
  excluded: new Set(),
};

/**
 * Reduces an address to the characters that are legal in one.
 *
 * A whitelist rather than a list of characters to strip, because the mangling
 * seen in practice cannot be enumerated: 259 of Shalvi Mishra's commits carry
 * `"shalvi.mishra@demandai.co"` wrapped in **smart quotes** (U+201C/U+201D)
 * from a bad git config, and other commits arrive with angle brackets. Keeping
 * only what belongs in an address merges those with the clean form without an
 * alias entry, and survives whatever the next malformed config produces.
 */
export function normaliseAddress(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._%+\-@]/g, '');
}

/**
 * Reads `fleet.identity.register`.
 *
 * Bitbucket hands out an address per commit and nothing else, and an address is
 * not a person: this estate has **29 distinct addresses for 22 humans**. Five
 * people commit under more than one address -- Makarand Prabhu under three --
 * so aggregating raw addresses would report them as several engineers each.
 * For per-person productivity figures that is not a rough edge; it is the
 * numbers being wrong about who did the work.
 *
 * Tolerant like the ownership register: this is hand-maintained reference data,
 * so a typo in it must degrade the figures rather than fail startup. Anything
 * skipped is logged, because a silently dropped engineer looks identical to one
 * who did nothing.
 *
 * This file is the directory until Entra ID supplies a real one.
 */
export function readIdentityRegister(
  config: Config | undefined,
  logger?: LoggerService,
): IdentityRegister {
  if (!config) return EMPTY_IDENTITY_REGISTER;

  const people: RegisteredEngineer[] = [];
  const byAddress = new Map<string, RegisteredEngineer>();

  const peopleConfig = config.getOptionalConfig('people');
  for (const key of peopleConfig?.keys() ?? []) {
    const entry = peopleConfig!.getOptionalConfig(key);
    const name = entry?.getOptionalString('name');
    const email = entry?.getOptionalString('email');
    if (!name) {
      logger?.warn(
        `Identity register: '${key}' has no name and will be ignored; work ` +
          `under its addresses will count as unregistered`,
      );
      continue;
    }

    const person: RegisteredEngineer = { key, name, email };
    const addresses = [
      ...(email ? [email] : []),
      ...(entry?.getOptionalStringArray('aliases') ?? []),
    ];

    // A person with no address at all is still registered: they resolve by
    // name, which is all a pull request gives us anyway.
    let claimed = addresses.length === 0;
    for (const address of addresses) {
      const normalised = normaliseAddress(address);
      if (!normalised) continue;
      const existing = byAddress.get(normalised);
      if (existing) {
        // Two people cannot share an address. First writer wins so a later
        // typo cannot quietly reassign somebody's commits.
        logger?.warn(
          `Identity register: '${address}' is claimed by both '${existing.key}' ` +
            `and '${key}'; keeping '${existing.key}'`,
        );
        continue;
      }
      byAddress.set(normalised, person);
      claimed = true;
    }

    if (claimed) people.push(person);
  }

  const excluded = new Set<string>();
  for (const address of config.getOptionalStringArray('notPeople') ?? []) {
    const normalised = normaliseAddress(address);
    if (!normalised) continue;
    if (byAddress.has(normalised)) {
      // Being both a person and not a person is a contradiction the register
      // should be told about rather than have resolved silently.
      logger?.warn(
        `Identity register: '${address}' appears under people and notPeople; ` +
          `treating it as a person`,
      );
      continue;
    }
    excluded.add(normalised);
  }

  return { people, byAddress, excluded };
}

/**
 * The person behind an address, or undefined.
 *
 * Undefined covers two different cases on purpose, and callers should keep them
 * apart when reporting: an address the register excludes is **not a person**,
 * and one it has never heard of is **unregistered** -- a real human whose
 * commits are going uncounted until somebody adds them.
 */
export function resolveEngineer(
  register: IdentityRegister,
  email: string | undefined,
): RegisteredEngineer | undefined {
  return register.byAddress.get(normaliseAddress(email));
}

/** Whether the register says this address belongs to nobody. */
export function isNotAPerson(
  register: IdentityRegister,
  email: string | undefined,
): boolean {
  return register.excluded.has(normaliseAddress(email));
}

/**
 * Addresses the register cannot account for, deduplicated.
 *
 * Exists so a pass can say "342 commits from 3 unregistered addresses" instead
 * of quietly leaving them out of the totals.
 */
export function unregisteredAddresses(
  register: IdentityRegister,
  emails: Array<string | undefined>,
): string[] {
  const unknown = new Set<string>();
  for (const email of emails) {
    const normalised = normaliseAddress(email);
    if (!normalised) continue;
    if (register.byAddress.has(normalised)) continue;
    if (register.excluded.has(normalised)) continue;
    unknown.add(normalised);
  }
  return [...unknown].sort();
}
