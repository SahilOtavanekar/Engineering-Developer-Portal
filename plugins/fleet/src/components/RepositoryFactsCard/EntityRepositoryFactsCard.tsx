import { useEntity } from '@backstage/plugin-catalog-react';
import { RepositoryFactsCard } from './RepositoryFactsCard';

/**
 * Entity-page wrapper. Keeping this separate lets {@link RepositoryFactsCard}
 * stay a plain component that takes an entity, testable without a provider.
 */
export function EntityRepositoryFactsCard() {
  const { entity } = useEntity();
  return <RepositoryFactsCard entity={entity} />;
}
