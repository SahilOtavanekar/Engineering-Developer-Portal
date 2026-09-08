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

/**
 * The kind, as this portal names it.
 *
 * Backstage's `System` is the closest concept it has to a Bitbucket project,
 * and the whole portal calls it Project -- the catalog column, the entity
 * header, the About card's own label. Leaving the raw kind here made a
 * project's page contradict every other surface.
 *
 * A map rather than a rename at the source: the kind is `System` in the
 * catalog model, in entity refs and in URLs, and changing it would invalidate
 * every stored `spec.system` and every link. Only the display moves.
 */
function kindLabel(kind: string): string {
  return kind.toLocaleLowerCase('en-US') === 'system' ? 'Project' : kind;
}

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
 * Deliberately the catalog's own facts only -- ownership, kind, project,
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
  // `lifecycle` is deliberately not read. `spec.lifecycle` still exists and
  // still has to: it is REQUIRED by the Component v1alpha1 schema, alongside
  // `type` and `owner`, so an entity without it fails validation and is not
  // ingested at all. It is simply not shown, because it is `unknown` on most of
  // this estate -- nothing distinguishes a library from an abandoned service --
  // and a column of "unknown" is not information.
  const spec = entity.spec as { type?: unknown } | undefined;
  const type = typeof spec?.type === 'string' ? spec.type : undefined;
  // Which rows apply at all. `Project` and `Type` are Component spec fields.
  const isComponent = entity.kind.toLocaleLowerCase('en-US') === 'component';

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

          {/* Headed "Project", not "System".
              Backstage's System is the closest thing it has to a Bitbucket
              project, and every repository here belongs to one of six -- MDLH,
              AM, DDS, DAARWYN, RES, DAIWEB. Calling it a System asks the reader
              to translate.

              `defaultKind` keeps its value: that is the entity KIND, not a
              label, and it is what lets the link render as "MDLH" rather than
              "system:mdlh". */}
          {/* Shown for a Component, whether or not it has one: an em-dash
              here means "we looked and there is nothing", which is worth
              reporting. Omitted entirely for a Project's own page, where the
              field does not apply -- a System cannot belong to a System. */}
          {isComponent && (
            <Row label="Project">
              {systems.length > 0 ? (
                <EntityRefLinks entityRefs={systems} defaultKind="System" />
              ) : (
                <Value>{EMPTY}</Value>
              )}
            </Row>
          )}

          {/* The KIND, and the one place the word "System" survived a rename.
              The label was changed to Project above, but this row renders the
              raw `entity.kind`, so a project's own page read "Kind: System"
              directly under "Project". `kindLabel` maps the one kind this
              portal renames; everything else passes through untouched. */}
          <Row label="Kind">
            <Value>{kindLabel(entity.kind)}</Value>
          </Row>

          {/* **A row is hidden when the field does not APPLY, never merely
              because it is empty**, and the distinction cost a test to
              rediscover.

              The first attempt at reclaiming height here dropped any empty row,
              which reversed a decision this card's own test records -- "says so
              plainly when a field is absent rather than leaving a gap". That
              decision is right: an em-dash says the portal looked and found
              nothing, where a missing row says nothing at all and leaves the
              reader unable to tell absent data from an inapplicable field.

              What was actually wrong on a Project's page is narrower. `Project`
              and `Type` are Component `spec` fields, so on a System they are
              not absent, they are meaningless -- and printing "PROJECT --" and
              "TYPE --" there invited a reader to go looking for data that can
              never exist. Gating on the kind fixes that and keeps the em-dash
              everywhere it means something.

              Tags apply to every kind, so they keep theirs. */}
          {isComponent && (
            <Row label="Type">
              <Value>{type ?? EMPTY}</Value>
            </Row>
          )}

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
