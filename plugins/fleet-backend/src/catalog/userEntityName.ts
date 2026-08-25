/**
 * Entity name for a person, derived from their email address.
 *
 * The local part only: `brijesh.gupta@demandai.co` becomes `brijesh.gupta`.
 * Email is the identity key everywhere else in this plugin -- commits are
 * grouped by it, because the same person's display name varies by machine --
 * so deriving the name from anything else would let one person become two
 * entities.
 *
 * This is a stand-in, not an identity source of record. When Entra ID lands it
 * supplies both the name and the identity, and people whose Bitbucket email
 * differs from their directory address will need reconciling. Note the
 * consequence today: `examples/org.yaml` already declares
 * `user:default/sahilotavanekar`, and a commit from
 * `sahil.otavanekar@demandai.co` yields `sahil.otavanekar` -- a second entity
 * for the same person, which only a real directory can resolve.
 */
export function toUserEntityName(email: string): string | undefined {
  const local = email.split('@')[0] ?? '';
  const cleaned = local
    .toLowerCase()
    // Backstage entity names allow alphanumerics plus `-`, `_` and `.`.
    .replace(/[^a-z0-9\-_.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 63)
    .replace(/[^a-z0-9]+$/, '');

  // An address that reduces to nothing cannot be named. Returning undefined
  // rather than throwing: one unusable address must not stop the provider
  // registering everyone else.
  return cleaned || undefined;
}

/** `user:default/brijesh.gupta`, or undefined if the address is unusable. */
export function toUserEntityRef(email: string): string | undefined {
  const name = toUserEntityName(email);
  return name ? `user:default/${name}` : undefined;
}
