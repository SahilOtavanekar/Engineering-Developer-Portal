import { stringifyEntityRef } from '@backstage/catalog-model';
import type { BitbucketRepository } from '../bitbucket/types';

/**
 * Backstage entity names permit alphanumerics plus `-`, `_` and `.`, up to 63
 * characters, and must start and end with an alphanumeric.
 */
export function toEntityName(slug: string): string {
  const cleaned = slug
    // Runs of unsupported characters collapse to a single dash, so 'café-api'
    // becomes 'caf-api' rather than 'caf--api'.
    .replace(/[^A-Za-z0-9\-_.]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 63)
    .replace(/[^A-Za-z0-9]+$/, '');

  if (!cleaned) {
    throw new Error(`repository slug '${slug}' yields no valid entity name`);
  }
  return cleaned;
}

/**
 * The join key between the two stores. The catalog holds identity and
 * ownership; the fleet database holds facts. Both are keyed by this.
 */
export function toEntityRef(
  repository: Pick<BitbucketRepository, 'slug'>,
): string {
  return stringifyEntityRef({
    kind: 'Component',
    namespace: 'default',
    name: toEntityName(repository.slug),
  });
}
