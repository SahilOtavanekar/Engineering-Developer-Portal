import { Fragment, useMemo, useState, type CSSProperties } from 'react';
import { useApi, fetchApiRef } from '@backstage/frontend-plugin-api';
import type { ProductivityOverview } from '@internal/backstage-plugin-fleet-common';
import { Flex, Skeleton, Text } from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { formatHours, timeAgo } from '../../format';
import { buildPeriods, findPeriod, type PeriodId } from '../../periods';
import { CommitTrend } from '../CommitTrend';
import {
  cell,
  chip,
  fixedTable,
  headerCell,
  numericCell as numeric,
  numericHeaderCell,
  recessed,
  select as selectStyle,
  tablePanel,
  tableScroll,
} from '../../surfaces';

/**
 * Column widths, totalling 100.
 *
 * The same fixed layout the fleet table uses, and for the same reason -- see
 * `fixedTable`. Here it also stops `Engineer` swallowing every spare pixel: the
 * automatic algorithm gave the one text column the entire slack left over by
 * eight numeric ones, so a name sat in a 330px cell while `Avg merge` had
 * barely room for "3.5 hours".
 */
const COLUMNS: ReadonlyArray<{
  heading: string;
  width: string;
  numeric?: true;
}> = [
  { heading: 'Engineer', width: '22%' },
  { heading: 'Commits', width: '8%', numeric: true },
  { heading: 'Repos', width: '7%', numeric: true },
  { heading: 'PRs opened', width: '10%', numeric: true },
  { heading: 'Reviewed', width: '9%', numeric: true },
  { heading: 'Approved', width: '9%', numeric: true },
  { heading: 'Merged', width: '8%', numeric: true },
  { heading: 'Avg merge', width: '11%', numeric: true },
  { heading: 'Last commit', width: '16%' },
];

/** Grid so repository names line up in columns rather than a ragged list. */
const repositoryGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(14rem, 1fr))',
  gap: '0.25rem 1.5rem',
};

/** The engineer name, as the control that opens their detail. */
const disclosure: CSSProperties = {
  appearance: 'none',
  background: 'none',
  border: 'none',
  padding: 0,
  font: 'inherit',
  fontSize: '0.875rem',
  color: 'inherit',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  gap: '0.35rem',
  textAlign: 'left',
};

function useProductivity(since: Date, until: Date | undefined, repo?: string) {
  const { fetch } = useApi(fetchApiRef);
  const key = `${since.toISOString()}|${until?.toISOString() ?? ''}|${
    repo ?? ''
  }`;

  return useAsync(async (): Promise<ProductivityOverview> => {
    const params = new URLSearchParams({ since: since.toISOString() });
    if (until) params.set('until', until.toISOString());
    if (repo) params.set('repository', repo);

    const response = await fetch(`plugin://fleet/productivity?${params}`);
    if (response.status === 501) {
      throw new Error(
        'Productivity is not configured: set fleet.identity.register so commits can be attributed to people',
      );
    }
    if (!response.ok) {
      throw new Error(
        `Failed to load productivity: ${response.status} ${response.statusText}`,
      );
    }
    return response.json();
  }, [fetch, key]);
}

/**
 * Per-engineer figures, busiest first.
 *
 * **Eight of the ten measures section 8 asks for.** Lines added and deleted are
 * absent: Bitbucket exposes them only through a per-commit diffstat endpoint, so
 * collecting them costs roughly one request per commit -- about 4,000 for this
 * estate, eight times a full sweep -- which is a product decision rather than a
 * technical one.
 *
 * Two honesty notes are rendered on the page rather than left to the reader.
 * Approvals are a weak signal here: measured across this estate the median time
 * from opening a pull request to its first approval is **12 seconds**. And
 * anyone the identity register cannot account for is named, because an engineer
 * missing from the register looks exactly like one who did nothing.
 */
export function ProductivityPage() {
  // Fixed at mount: periods derived from a live clock would re-bucket the table
  // underneath the reader.
  const periods = useMemo(() => buildPeriods(new Date()), []);
  const [periodId, setPeriodId] = useState<PeriodId>('last-90-days');
  const [repository, setRepository] = useState<string | undefined>();
  // A set, not a single key: comparing two engineers side by side is the
  // reason to expand a row rather than open a page.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const period = findPeriod(periods, periodId);
  const { value, loading, error } = useProductivity(
    period.since,
    period.until,
    repository,
  );

  if (loading) return <Skeleton style={{ height: '18rem' }} />;
  if (error) {
    return (
      <Flex direction="column" gap="2">
        <Text weight="bold">Productivity is unavailable</Text>
        <Text color="secondary">{error.message}</Text>
      </Flex>
    );
  }
  if (!value) return <Text color="secondary">No figures yet.</Text>;

  const { engineers, repositories, unattributed, trendBucket } = value;

  const toggleExpanded = (key: string) =>
    setExpanded(current => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  return (
    <Flex direction="column" gap="5">
      {/*
        Period and repository sit on one row: both filter the same table, and
        stacking them spent a line of vertical space on a grouping that carries
        no meaning.

        Two nested groups rather than one flat row, because the gap has to say
        which controls belong together -- `5` between the groups against `3`
        inside them is what stops "Repository" reading as a sixth chip. Every
        level wraps, so a narrow viewport drops the repository filter onto its
        own line and degrades to the previous stacked layout instead of
        overflowing.
      */}
      <Flex gap="5" align="center" style={{ flexWrap: 'wrap' }}>
        <Flex gap="3" align="center" style={{ flexWrap: 'wrap' }}>
          {periods.map(p => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPeriodId(p.id)}
              aria-pressed={p.id === periodId}
              style={chip(p.id === periodId)}
            >
              {p.label}
            </button>
          ))}
        </Flex>

        {repositories.length > 0 && (
          // A dropdown rather than chips: the chip row rendered only the first
          // twelve, so on this estate 36 of 48 repositories could not be
          // selected at all. A native select also gets keyboard handling and
          // type-ahead for free, in keeping with the plain controls used on the
          // fleet filters.
          <Flex gap="3" align="center" style={{ flexWrap: 'wrap' }}>
            <label htmlFor="productivity-repository">
              {/*
                `body-small`, a step up from the `body-x-small` used for table
                microcopy. On its own row this label sat above the control and
                read as a caption; inline beside the chips it is the only thing
                naming the control next to it, so it takes the same size as the
                chip text rather than shrinking away from it.
              */}
              <Text variant="body-small" color="secondary">
                Repository
              </Text>
            </label>
            <select
              id="productivity-repository"
              value={repository ?? ''}
              onChange={event => setRepository(event.target.value || undefined)}
              style={selectStyle}
            >
              {/* The empty value is "no filter"; it round-trips through
                  `|| undefined` so the query parameter is simply omitted. */}
              <option value="">All ({repositories.length})</option>
              {repositories.map(slug => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </Flex>
        )}
      </Flex>

      {engineers.length === 0 ? (
        <Text color="secondary">
          Nobody committed or opened a pull request in this period.
        </Text>
      ) : (
        // Given a card of its own, matching the fleet table. See `tablePanel`
        // for why this surface is opaque where the rest of the portal's are
        // translucent.
        <div style={tablePanel}>
          <div style={tableScroll}>
            <table style={fixedTable('56rem')}>
              <colgroup>
                {COLUMNS.map(column => (
                  <col key={column.heading} style={{ width: column.width }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {COLUMNS.map(column => (
                    <th
                      key={column.heading}
                      style={column.numeric ? numericHeaderCell : headerCell}
                    >
                      {column.heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {engineers.map(e => (
                  <Fragment key={e.key}>
                    <tr>
                      <td style={cell}>
                        {/* `Text` is display:inline-block, so two of them in a
                        bare cell flow side by side -- the name and address ran
                        together as one string. A column forces the stack. */}
                        <Flex direction="column" gap="1">
                          <button
                            type="button"
                            onClick={() => toggleExpanded(e.key)}
                            aria-expanded={expanded.has(e.key)}
                            style={disclosure}
                          >
                            <span aria-hidden style={{ fontSize: '0.7rem' }}>
                              {expanded.has(e.key) ? '▾' : '▸'}
                            </span>
                            {e.name}
                          </button>
                          {e.email && (
                            <Text variant="body-x-small" color="secondary">
                              {e.email}
                            </Text>
                          )}
                        </Flex>
                      </td>
                      <td style={numeric}>{e.commits}</td>
                      <td style={numeric}>{e.activeRepositories}</td>
                      <td style={numeric}>{e.pullRequestsCreated}</td>
                      <td style={numeric}>{e.pullRequestsReviewed}</td>
                      <td style={numeric}>{e.pullRequestsApproved}</td>
                      <td style={numeric}>{e.pullRequestsMerged}</td>
                      <td style={numeric}>
                        {formatHours(e.averageMergeHours) ?? '—'}
                      </td>
                      <td style={cell}>
                        <Text variant="body-x-small" color="secondary">
                          {timeAgo(e.lastCommitAt) ?? '—'}
                        </Text>
                      </td>
                    </tr>
                    {expanded.has(e.key) && (
                      <tr>
                        {/* One cell spanning the table: a detail panel laid out in
                        the parent's columns would be forced into shapes that
                        suit the summary, not the detail. */}
                        <td
                          colSpan={COLUMNS.length}
                          style={{
                            ...cell,
                            ...recessed,
                          }}
                        >
                          <Flex direction="column" gap="4">
                            <Flex
                              direction="column"
                              gap="2"
                              style={{ minWidth: 0 }}
                            >
                              <Text variant="body-x-small" color="secondary">
                                Repositories ({e.repositories.length})
                              </Text>
                              {e.repositories.length > 0 ? (
                                <div style={repositoryGrid}>
                                  {e.repositories.map(r => (
                                    <Flex
                                      key={r.slug}
                                      gap="2"
                                      align="baseline"
                                      style={{
                                        justifyContent: 'space-between',
                                        minWidth: 0,
                                      }}
                                    >
                                      <Text
                                        variant="body-small"
                                        style={{ overflowWrap: 'anywhere' }}
                                      >
                                        {r.slug}
                                      </Text>
                                      <Text
                                        variant="body-x-small"
                                        color="secondary"
                                        style={{
                                          fontVariantNumeric: 'tabular-nums',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        {r.commits}
                                      </Text>
                                    </Flex>
                                  ))}
                                </div>
                              ) : (
                                <Text variant="body-x-small" color="secondary">
                                  No commits in this period. Their pull request
                                  figures above may still be non-zero —
                                  reviewing is not committing.
                                </Text>
                              )}
                            </Flex>

                            <div style={{ maxWidth: '32rem' }}>
                              <CommitTrend
                                trend={e.commitTrend}
                                bucket={trendBucket}
                              />
                            </div>
                          </Flex>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Flex direction="column" gap="2">
        <Text variant="body-x-small" color="secondary">
          Approved counts approvals, not scrutiny: across this estate the median
          time from opening a pull request to its first approval is 12 seconds.
          Merged counts who pressed the button, which is often not the author.
        </Text>
        <Text variant="body-x-small" color="secondary">
          Lines added and deleted are not shown. Bitbucket exposes them only per
          commit, at roughly one request each — about 4,000 for this estate.
        </Text>
        {(unattributed.commitAddresses.length > 0 ||
          unattributed.pullRequestNames.length > 0) && (
          // Named rather than dropped: an engineer missing from the register
          // looks exactly like one who did nothing.
          <Text variant="body-x-small" color="secondary">
            Not attributed to anyone —{' '}
            {[
              ...unattributed.commitAddresses,
              ...unattributed.pullRequestNames,
            ].join(', ')}
            {unattributed.commits > 0
              ? ` (${unattributed.commits} commits). Add them to catalog/identity-register.yaml.`
              : '. Add them to catalog/identity-register.yaml.'}
          </Text>
        )}
      </Flex>
    </Flex>
  );
}
