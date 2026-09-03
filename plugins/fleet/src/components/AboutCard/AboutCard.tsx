import type { CSSProperties, ReactNode } from 'react';
import {
  RELATION_OWNED_BY,
  RELATION_PART_OF,
  type Entity,
} from '@backstage/catalog-model';
import {
  EntityRefLinks,
  getEntityRelations,
  useEntity,
} from '@backstage/plugin-catalog-react';
import { Card, CardBody, CardHeader, Flex, Link, Text } from '@backstage/ui';
import { BORDER_SOFT, sectionLabel, tag as TAG } from '../../surfaces';

const EMPTY = '—';

/** `backstage.io/source-location`, stamped by the Bitbucket entity provider. */
const SOURCE_LOCATION = 'backstage.io/source-location';

/**
 * Label above value, never side by side in fixed columns.
 *
 * This card replaced the stock one, which laid its fields out in a grid of
 * `{ initial: 1, sm: 2, lg: 3 }` columns. Those breakpoints are resolved
 * against `window.matchMedia` -- the **viewport** -- while the card itself
 * lives in the entity layout's narrow `1fr` sidebar. On any wide screen it
 * therefore rendered three columns into a ~350px card, overflowed, and grew a
 * horizontal scrollbar.
 *
 * A single column keyed to nothing but the card's own width cannot do that at
 * any viewport size.
 */
const ROW: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr)',
  gap: '0.15rem',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={ROW}>
      <Text variant="body-x-small" color="secondary" style={sectionLabel}>
        {label}
      </Text>
      {/* `minWidth: 0` lets a long owner name wrap instead of forcing the
          card wider than its column. */}
      <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return <Text variant="body-small">{children}</Text>;
}

/** Resolves `url:https://...` and bare URLs; anything else is not a link. */
function sourceHref(entity: Entity): string | undefined {
  const raw = entity.metadata.annotations?.[SOURCE_LOCATION];
  if (!raw) return undefined;
  const target = raw.startsWith('url:') ? raw.slice('url:'.length) : raw;
  return target.startsWith('http://') || target.startsWith('https://')
    ? target
    : undefined;
}

/**
 * Identity and classification for an entity, from the catalog.
 *
 * Deliberately the catalog's own facts only -- ownership, kind, lifecycle,
 * tags. Everything measured lives on the Repository activity card beside it,
 * which reads the fleet database. Keeping the split visible here is the same
 * split the two stores are built on.
 */
export function AboutCard({ entity }: { entity: Entity }) {
  const owners = getEntityRelations(entity, RELATION_OWNED_BY);
  const systems = getEntityRelations(entity, RELATION_PART_OF, {
    kind: 'system',
  });
  const tags = entity.metadata.tags ?? [];
  const href = sourceHref(entity);
  const spec = entity.spec as
    | { type?: unknown; lifecycle?: unknown }
    | undefined;
  const type = typeof spec?.type === 'string' ? spec.type : undefined;
  const lifecycle =
    typeof spec?.lifecycle === 'string' ? spec.lifecycle : undefined;

  return (
    <Card>
      <CardHeader>
        <Text variant="title-small">About</Text>
      </CardHeader>
      <CardBody>
        <Flex direction="column" gap="4">
          <Row label="Description">
            <Value>{entity.metadata.description || 'No description'}</Value>
          </Row>

          <Row label="Owner">
            {owners.length > 0 ? (
              <EntityRefLinks entityRefs={owners} defaultKind="Group" />
            ) : (
              <Value>{EMPTY}</Value>
            )}
          </Row>

          <Row label="System">
            {systems.length > 0 ? (
              <EntityRefLinks entityRefs={systems} defaultKind="System" />
            ) : (
              <Value>{EMPTY}</Value>
            )}
          </Row>

          <Row label="Kind">
            <Value>{entity.kind}</Value>
          </Row>

          <Row label="Type">
            <Value>{type ?? EMPTY}</Value>
          </Row>

          <Row label="Lifecycle">
            <Value>{lifecycle ?? EMPTY}</Value>
          </Row>

          <Row label="Tags">
            {tags.length > 0 ? (
              <Flex gap="2" style={{ flexWrap: 'wrap' }}>
                {tags.map(tag => (
                  <span key={tag} style={TAG}>
                    {tag}
                  </span>
                ))}
              </Flex>
            ) : (
              <Value>{EMPTY}</Value>
            )}
          </Row>

          {href && (
            <div style={{ borderTop: BORDER_SOFT, paddingTop: '0.75rem' }}>
              <Link href={href} target="_blank" rel="noreferrer">
                View source
              </Link>
            </div>
          )}
        </Flex>
      </CardBody>
    </Card>
  );
}

/** Entity-page wrapper, so the extension does not need to plumb the entity. */
export function EntityAboutCard() {
  const { entity } = useEntity();
  return <AboutCard entity={entity} />;
}
