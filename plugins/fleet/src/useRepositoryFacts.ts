import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { RepositoryFacts } from '@internal/backstage-plugin-fleet-common';
import type { Entity } from '@backstage/catalog-model';
import useAsync from 'react-use/esm/useAsync';

/**
 * Fetches the fleet database's facts for one catalog entity.
 *
 * Resolves to `undefined` rather than throwing when the portal holds no facts
 * for the entity: a repository the ingestion has not reached yet is an ordinary
 * state, not an error worth showing the reader.
 */
export function useRepositoryFacts(entity: Entity) {
  const { fetch } = useApi(fetchApiRef);

  const kind = entity.kind.toLowerCase();
  const namespace = (entity.metadata.namespace ?? 'default').toLowerCase();
  const name = entity.metadata.name;

  return useAsync(async (): Promise<RepositoryFacts | undefined> => {
    const response = await fetch(
      `plugin://fleet/repositories/by-entity/${kind}/${namespace}/${encodeURIComponent(
        name,
      )}`,
    );

    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw new Error(
        `Failed to load repository facts: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }, [fetch, kind, namespace, name]);
}
