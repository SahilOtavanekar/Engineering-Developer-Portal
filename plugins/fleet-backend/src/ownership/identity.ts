/**
 * Joining a Bitbucket display name to an email address.
 *
 * Repository permissions name people but carry no email:
 * `GET /2.0/users/{account_id}` would supply one and returns 403 without the
 * `read:user` scope. Commits carry the email and no reliable name. Ownership
 * needs both -- the permission says who is accountable, the email is what the
 * catalog keys a User entity on.
 *
 * So the two are joined on a normalised name. Measured against this estate:
 * **14 of 16 admins match a known commit author**, because addresses follow
 * `first.last@demandai.co`. The two that do not are admins who have not
 * committed in 90 days.
 *
 * This is string matching, not identity. It is a stand-in until Entra ID
 * supplies a directory, and every proposal it produces records which source it
 * came from so a wrong join is traceable rather than invisible.
 */

/** Lowercase alphanumerics joined by single dashes. */
export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export interface KnownAuthor {
  name?: string;
  email: string;
}

/**
 * An index from normalised name to email, built once per pass.
 *
 * Both the commit author's display name and the local part of their address
 * are indexed: `Gurudutt .` normalises to `gurudutt`, which matches the local
 * part of `gurudutt@demandai.co` even though the display name carries a
 * trailing dot.
 */
export class AuthorIndex {
  private readonly byName = new Map<string, string>();

  constructor(authors: KnownAuthor[] = []) {
    for (const author of authors) {
      const local = author.email.split('@')[0];
      for (const key of [author.name, local]) {
        if (!key) continue;
        const normalised = normaliseName(key);
        // First writer wins, so a later namesake cannot silently take over an
        // address already claimed.
        if (normalised && !this.byName.has(normalised)) {
          this.byName.set(normalised, author.email);
        }
      }
    }
  }

  /** The email for a display name, or undefined when nothing matches. */
  emailFor(displayName: string | undefined): string | undefined {
    if (!displayName) return undefined;
    const normalised = normaliseName(displayName);
    if (!normalised) return undefined;
    return this.byName.get(normalised);
  }

  get size(): number {
    return this.byName.size;
  }
}
