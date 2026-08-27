/**
 * The one ownership source that is confirmed rather than inferred.
 *
 * Lives in the common package because three places must agree on it and they
 * cannot import from each other: the resolver that writes it, the entity
 * provider that decides whether to caveat the owner, the scorer that decides
 * whether to award the metric, and the card that decides whether to call the
 * owner a guess. A mismatch in any one of them would silently describe a
 * confirmed owner as a guess, or worse, the reverse.
 */
export const OWNERSHIP_SOURCE_REGISTER = 'ownership-register';

/** Whether an ownership proposal came from the confirmed register. */
export function isConfirmedOwnership(source: string | undefined): boolean {
  return source === OWNERSHIP_SOURCE_REGISTER;
}
