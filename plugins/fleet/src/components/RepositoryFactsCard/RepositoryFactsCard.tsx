import type { CSSProperties, ReactNode } from 'react';
import type { Entity } from '@backstage/catalog-model';
import {
  Card,
  CardBody,
  CardHeader,
  Flex,
  Link,
  Skeleton,
  Text,
} from '@backstage/ui';
import { ScoreTrend } from '../ScoreTrend';
import { formatBytes, formatHours, timeAgo } from '../../format';
import {
  deriveProblems,
  describeDormancy,
  isConfirmedOwnership,
  shouldHighlightProblems,
  type RepositoryFacts,
} from '@internal/backstage-plugin-fleet-common';
import { BAND_FILL, BAND_LABEL, BAND_TEXT } from '../../bands';

import { useRepositoryFacts } from '../../useRepositoryFacts';

const EMPTY = '—';

const BORDER = '1px solid var(--bui-border-soft, #e2e7f0)';

/**
 * Figures line up in a column only if the digits are the same width.
 *
 * Proportional digits make a stack of scores and counts look ragged, which is
 * the single cheapest thing to fix on a card that is mostly numbers.
 */
const NUMERIC: CSSProperties = { fontVariantNumeric: 'tabular-nums' };

/**
 * A grid rather than a wrapping flex row.
 *
 * Wrapped flex items align to their own content width, so each row of stats
 * started at a different place and the card read as a jumble. A grid puts every
 * label on the same vertical line whatever the value beneath it.
 */
const STAT_GRID: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))',
  gap: '0.875rem 1.25rem',
};

/** "34 of 41 commits (83%)" -- the evidence, not just the verdict. */
function contributionDetail(commits: number, windowCommits: number) {
  const share =
    windowCommits > 0 ? Math.round((commits / windowCommits) * 100) : 0;
  return `${commits} of ${windowCommits} commits (${share}%)`;
}

/** Enough of a commit hash to recognise, not so much it wraps. */
function shortHash(hash?: string) {
  return hash ? hash.slice(0, 7) : undefined;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="1">
      <Text variant="body-x-small" color="secondary">
        {label}
      </Text>
      {children}
    </Flex>
  );
}

/** One figure in a stat grid, with an optional line of context under it. */
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <Flex direction="column" gap="1">
      <Text variant="body-x-small" color="secondary">
        {label}
      </Text>
      <Text variant="title-medium" style={NUMERIC}>
        {value}
      </Text>
      {hint !== undefined && hint !== null && (
        <Text variant="body-x-small" color="secondary">
          {hint}
        </Text>
      )}
    </Flex>
  );
}

/**
 * A titled block, separated from the one above by a rule.
 *
 * The card previously ran fourteen groups together at one visual level, so
 * pipeline counts and repository metadata were indistinguishable at a glance.
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Flex
      direction="column"
      gap="3"
      style={{ borderTop: BORDER, paddingTop: '1rem' }}
    >
      <Text
        variant="body-x-small"
        color="secondary"
        style={{ textTransform: 'uppercase', letterSpacing: '0.06em' }}
        weight="bold"
      >
        {title}
      </Text>
      {children}
    </Flex>
  );
}

/**
 * One scorer's result: name, points, a proportional bar, then the detail.
 *
 * Points and detail used to share a single wrapped line, so nothing lined up
 * and the numbers were the hardest part to find. They are their own column now.
 *
 * The bar is coloured by outcome rather than by band -- full marks, nothing, or
 * somewhere between -- because a metric at zero inside a healthy repository is
 * exactly what a reader is scanning for.
 */
function MetricRow({
  metric,
}: {
  metric: {
    id: string;
    title: string;
    detail: string;
    weight: number;
    points?: number;
    available: boolean;
  };
}) {
  const fraction =
    metric.available && metric.weight > 0
      ? Math.max(0, Math.min(1, (metric.points ?? 0) / metric.weight))
      : 0;

  let fill = 'var(--bui-warning-bg)';
  if (!metric.available) fill = 'transparent';
  else if (fraction >= 1) fill = 'var(--bui-positive-bg)';
  else if (fraction <= 0) fill = 'var(--bui-negative-bg)';

  return (
    <Flex direction="column" gap="1">
      <Flex
        gap="3"
        align="baseline"
        style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}
      >
        <Text variant="body-small">{metric.title}</Text>
        <Text
          variant="body-x-small"
          color="secondary"
          style={{ ...NUMERIC, whiteSpace: 'nowrap' }}
        >
          {metric.available
            ? `${metric.points} / ${metric.weight}`
            : `not measured yet (worth ${metric.weight})`}
        </Text>
      </Flex>
      <div
        style={{
          height: '4px',
          borderRadius: '2px',
          background: 'var(--bui-bg-surface-2, #eef1f6)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${Math.round(fraction * 100)}%`,
            height: '100%',
            background: fill,
          }}
        />
      </div>
      {metric.available && (
        <Text variant="body-x-small" color="secondary">
          {metric.detail}
        </Text>
      )}
    </Flex>
  );
}

/**
 * Who made the repository's earliest commit.
 *
 * Labelled by how good the evidence is, rather than asserting a creator in
 * every case. Bitbucket exposes no creator at all -- its repository `owner` is
 * the workspace -- so the first commit's author is the only source there is.
 *
 * Where the earliest commit **predates the repository**, history was carried in
 * from somewhere else and its author may never have touched this repository.
 * That is 5 of 96 here, and those read "First commit by" with the reason
 * spelled out, not "Created by".
 */
function CreatedBy({
  createdBy,
}: {
  createdBy: NonNullable<RepositoryFacts['createdBy']>;
}) {
  const who = createdBy.name ?? createdBy.email ?? EMPTY;
  return (
    <Field label={createdBy.importedHistory ? 'First commit by' : 'Created by'}>
      <Flex direction="column" gap="1">
        <Text variant="body-small">
          {who}
          {createdBy.notAPerson ? ' (automation, not a person)' : ''}
        </Text>
        {createdBy.importedHistory ? (
          <Text variant="body-x-small" color="secondary">
            The earliest commit predates this repository, so its history was
            imported — this is who wrote that commit, not necessarily who
            created the repository.
          </Text>
        ) : (
          <Text variant="body-x-small" color="secondary">
            Derived from the earliest commit. Bitbucket records no creator.
          </Text>
        )}
      </Flex>
    </Field>
  );
}

/**
 * Repository facts drawn from the fleet database rather than the catalog.
 *
 * The split matters: the catalog holds identity and ownership, this holds
 * measured activity. Both are keyed by the same entity ref.
 */
export function RepositoryFactsCard({ entity }: { entity: Entity }) {
  const { value: facts, loading, error } = useRepositoryFacts(entity);

  let body: ReactNode;

  if (loading) {
    body = <Skeleton style={{ height: '5rem' }} />;
  } else if (error) {
    body = (
      <Text color="secondary">
        Could not load repository facts. {error.message}
      </Text>
    );
  } else if (!facts) {
    // Ingestion has not reached this repository yet -- an ordinary state
    // rather than a failure, so it reads as information, not an error.
    body = (
      <Text color="secondary">
        No repository facts recorded yet. They appear after the next Bitbucket
        synchronisation.
      </Text>
    );
  } else {
    const window = `${facts.activity.windowDays}d`;
    const score = facts.score;
    const partial =
      score !== undefined && score.availableWeight < score.nominalWeight;
    // Derived from the breakdown the scoring pass already wrote -- no extra
    // request, and nothing stored that could disagree with the score above it.
    const problems = deriveProblems(score, facts.lifetime);
    const highlight = shouldHighlightProblems(score);
    const reviews = facts.reviews;
    const branches = facts.branches;
    const pipelines = facts.pipelines;
    const hasPipelineRuns =
      pipelines !== undefined &&
      (pipelines.successful > 0 ||
        pipelines.failed > 0 ||
        pipelines.cancelled > 0 ||
        pipelines.running > 0);
    const hasDelivery =
      (reviews !== undefined &&
        (reviews.merged > 0 ||
          reviews.open > 0 ||
          reviews.medianReviewHours !== undefined ||
          reviews.medianMergeHours !== undefined)) ||
      (branches !== undefined && branches.total > 0);

    body = (
      <Flex direction="column" gap="5">
        {score && (
          // The headline, given its own panel so the number that matters is
          // not just the first of forty in a flat list.
          <Flex
            gap="6"
            align="center"
            style={{
              flexWrap: 'wrap',
              border: BORDER,
              borderRadius: '6px',
              padding: '0.875rem 1rem',
            }}
          >
            <Field label="Health score">
              <Flex gap="2" align="baseline">
                <Text
                  variant="title-large"
                  style={{ ...NUMERIC, color: BAND_TEXT[score.band] }}
                >
                  {score.total}
                </Text>
                <Text variant="body-small" color="secondary">
                  / 100
                </Text>
              </Flex>
            </Field>
            <Field label="Band">
              <span
                style={{
                  ...BAND_FILL[score.band],
                  padding: '0.15rem 0.6rem',
                  borderRadius: '999px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  whiteSpace: 'nowrap',
                }}
              >
                {BAND_LABEL[score.band] ?? score.band}
              </span>
            </Field>
            <Field label="Measured">
              <Text variant="title-medium" style={NUMERIC}>
                {score.availableWeight} of {score.nominalWeight} weight
              </Text>
            </Field>
            {score.history && (
              <Field label="Trend">
                <ScoreTrend history={score.history} />
              </Field>
            )}
          </Flex>
        )}

        {partial && (
          // Every metric has a data source now, so a short denominator no
          // longer means the portal is unfinished -- it means this repository
          // has nothing to measure for one of them: no pipeline runs, no merged
          // pull requests, no commits on its default branch in the window. Two
          // very different things that read identically if the wording does not
          // distinguish them.
          <Text variant="body-x-small" color="secondary">
            Scored over the {score!.availableWeight} of {score!.nominalWeight}{' '}
            weight this repository has data for — the rest of its metrics have
            nothing to measure yet. Band thresholds are placeholders pending
            sign-off.
          </Text>
        )}

        {highlight && (problems.actionable.length > 0 || problems.dormancy) && (
          // A tinted callout rather than a bare left rule: this is the one part
          // of the card a reader is meant to act on.
          <Flex
            direction="column"
            gap="3"
            style={{
              borderLeft: `3px solid ${
                BAND_TEXT[score!.band] ?? 'var(--bui-border)'
              }`,
              background: 'var(--bui-bg-surface-2, #f5f7fa)',
              borderRadius: '0 4px 4px 0',
              padding: '0.75rem 0.875rem',
            }}
          >
            {problems.actionable.length > 0 && (
              <Flex direction="column" gap="3">
                <Text variant="body-small" weight="bold">
                  Problems — {problems.actionable.length} costing{' '}
                  {Math.round(problems.lostPoints)} points
                </Text>
                {problems.actionable.map(problem => (
                  <Flex key={problem.id} direction="column" gap="1">
                    <Flex
                      gap="3"
                      align="baseline"
                      style={{
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                      }}
                    >
                      <Text variant="body-small" weight="bold">
                        {problem.title}
                      </Text>
                      <Text
                        variant="body-x-small"
                        color="secondary"
                        style={{ ...NUMERIC, whiteSpace: 'nowrap' }}
                      >
                        {Math.round(problem.lost)} of {problem.weight} points
                        lost
                      </Text>
                    </Flex>
                    <Text variant="body-x-small" color="secondary">
                      {problem.detail}
                    </Text>
                    {problem.remediation && (
                      // The scorer's own words: it is the only thing that knows
                      // its configured target.
                      <Text variant="body-x-small" color="secondary">
                        {problem.remediation}
                      </Text>
                    )}
                  </Flex>
                ))}
              </Flex>
            )}

            {problems.dormancy && (
              // A scaffold and an abandoned service both show "no commits",
              // and they need opposite responses -- so this says which, and
              // never presents a repository nobody ever developed as one
              // that decayed.
              <Text variant="body-x-small" color="secondary">
                {describeDormancy(problems.dormancy, facts.activity.windowDays)}
              </Text>
            )}
          </Flex>
        )}

        {score && (
          <Section title="Scorecard">
            <Flex direction="column" gap="3">
              {score.breakdown.map(metric => (
                <MetricRow key={metric.id} metric={metric} />
              ))}
            </Flex>
          </Section>
        )}

        <Section title={`Activity — last ${facts.activity.windowDays} days`}>
          <div style={STAT_GRID}>
            <Stat
              label={`Commits (${window})`}
              value={facts.activity.commits}
            />
            <Stat
              label={`Authors (${window})`}
              value={facts.activity.authors}
            />
            <Stat
              label="Last commit"
              value={timeAgo(facts.lastCommitAt) ?? 'Never'}
            />
          </div>
          {facts.contributors && facts.contributors.length > 0 && (
            // Named, not just counted: the Authors stat above gives the
            // number. Resolved through the identity register, so one person
            // committing under two addresses appears once.
            <Field label="Active contributors">
              <Text variant="body-small">
                {facts.contributors
                  .map(
                    contributor =>
                      `${contributor.name ?? contributor.email ?? 'unknown'} (${
                        contributor.commits
                      })`,
                  )
                  .join(' · ')}
              </Text>
            </Field>
          )}
          {facts.contributors?.some(c => c.unregistered) && (
            // Named rather than dropped: someone missing from the register
            // looks exactly like someone who did nothing.
            <Text variant="body-x-small" color="secondary">
              Some contributors are not in the identity register, so their
              commits may be split across addresses. Add them to
              catalog/identity-register.yaml.
            </Text>
          )}
        </Section>

        {facts.lifetime && facts.lifetime.commits > 0 && (
          // The window above answers "is this maintained now". This answers
          // "what is this" -- two commits ever and five hundred look identical
          // through a 90-day window once work stops.
          <Section title="All time">
            <div style={STAT_GRID}>
              <Stat label="Commits (all time)" value={facts.lifetime.commits} />
              <Stat
                label="Contributors (all time)"
                value={facts.lifetime.authors}
              />
              <Stat
                label="First commit"
                value={timeAgo(facts.lifetime.firstCommitAt) ?? EMPTY}
              />
              <Stat
                label="Newest commit"
                value={timeAgo(facts.lifetime.lastCommitAt) ?? EMPTY}
              />
            </div>
            {facts.createdBy && <CreatedBy createdBy={facts.createdBy} />}
          </Section>
        )}

        {hasDelivery && (
          <Section title="Pull requests and branches">
            <div style={STAT_GRID}>
              {reviews && reviews.merged > 0 && (
                <Stat
                  label={`Reviewed (${window})`}
                  value={`${reviews.approved} of ${reviews.merged}`}
                  hint="merged PRs"
                />
              )}
              {reviews?.medianReviewHours !== undefined && (
                // Opening to first approval: how long the author waited to be
                // unblocked, which is not the same as how long the change took
                // to land.
                <Stat
                  label="Median review time"
                  value={formatHours(reviews.medianReviewHours)}
                />
              )}
              {reviews?.medianMergeHours !== undefined && (
                <Stat
                  label="Median merge time"
                  value={formatHours(reviews.medianMergeHours)}
                />
              )}
              {reviews && reviews.open > 0 && (
                <Stat label="Open PRs" value={reviews.open} />
              )}
              {branches && branches.total > 0 && (
                <Stat
                  label="Stale branches"
                  value={`${branches.stale} of ${branches.total}`}
                />
              )}
            </div>
            {branches?.divergence && (
              // Reported only once measured. An unmeasured repository shows
              // nothing rather than a reassuring zero.
              <Field label="Unmerged work on branches">
                <Flex direction="column" gap="1">
                  <Text variant="body-small">
                    {branches.divergence.diverged === 0
                      ? `Nothing stranded across ${
                          branches.divergence.measured
                        } branch${
                          branches.divergence.measured === 1 ? '' : 'es'
                        }.`
                      : `${branches.divergence.commits}${
                          branches.divergence.capped ? '+' : ''
                        } commit${
                          branches.divergence.commits === 1 ? '' : 's'
                        } on ${branches.divergence.diverged} of ${
                          branches.divergence.measured
                        } branches never reached the default branch.`}
                  </Text>
                  {branches.divergence.worst.length > 0 && (
                    <Text variant="body-x-small" color="secondary">
                      {branches.divergence.worst
                        .map(
                          branch =>
                            `${branch.name} (${branch.commits}${
                              branch.capped ? '+' : ''
                            })`,
                        )
                        .join(' · ')}
                    </Text>
                  )}
                  <Text variant="body-x-small" color="secondary">
                    Branches with a merged pull request are excluded — a squash
                    merge leaves their commits off the default branch even
                    though the work shipped.
                  </Text>
                </Flex>
              </Field>
            )}
            {branches && branches.stalest.length > 0 && (
              <Field label="Longest abandoned">
                <Text variant="body-small" color="secondary">
                  {branches.stalest
                    .map(
                      branch =>
                        `${branch.name} (${
                          timeAgo(branch.lastCommitAt) ?? 'no commits'
                        })`,
                    )
                    .join(' · ')}
                </Text>
              </Field>
            )}
          </Section>
        )}

        {hasPipelineRuns && (
          <Section title="Recent pipeline runs">
            <div style={STAT_GRID}>
              <Stat label="Passed" value={pipelines!.successful} />
              <Stat label="Failed" value={pipelines!.failed} />
              {/* Shown separately from failures on purpose: a build somebody
                  stopped is not evidence the code is broken, and it is left
                  out of the success rate for the same reason. */}
              <Stat label="Cancelled" value={pipelines!.cancelled} />
              <Stat label="Running" value={pipelines!.running} />
              {pipelines!.successRate !== undefined && (
                <Stat
                  label="Success rate"
                  value={`${Math.round(pipelines!.successRate * 100)}%`}
                />
              )}
            </div>
            {pipelines!.lastRunAt && (
              <Text variant="body-x-small" color="secondary">
                Last run {timeAgo(pipelines!.lastRunAt)}
                {pipelines!.lastResult
                  ? ` — ${pipelines!.lastResult.toLowerCase()}`
                  : ''}
              </Text>
            )}
          </Section>
        )}

        {facts.ownershipProposal && (
          <Section
            title={
              isConfirmedOwnership(facts.ownershipProposal.source)
                ? 'Owner — confirmed'
                : 'Suggested owner — not confirmed'
            }
          >
            {facts.ownershipProposal.proposed ? (
              <Flex direction="column" gap="1">
                <Text variant="title-medium">
                  {facts.ownershipProposal.proposed.name ??
                    facts.ownershipProposal.proposed.email ??
                    EMPTY}
                </Text>
                {isConfirmedOwnership(facts.ownershipProposal.source) ? (
                  // Never a commit share first. This owner does not rest on
                  // commits, and leading with them invites the reader to
                  // re-derive a conclusion that was not derived.
                  <Text variant="body-x-small" color="secondary">
                    Confirmed in the ownership register, and the owner of this
                    component in the catalog.
                    {facts.ownershipProposal.proposed.commits > 0
                      ? ` Also ${contributionDetail(
                          facts.ownershipProposal.proposed.commits,
                          facts.ownershipProposal.windowCommits,
                        )} in ${facts.ownershipProposal.windowDays} days.`
                      : ''}
                  </Text>
                ) : (
                  <Text variant="body-x-small" color="secondary">
                    {contributionDetail(
                      facts.ownershipProposal.proposed.commits,
                      facts.ownershipProposal.windowCommits,
                    )}{' '}
                    in {facts.ownershipProposal.windowDays} days. Derived from{' '}
                    {facts.ownershipProposal.source}, and a guess — this
                    repository is still owned by{' '}
                    <code>group:default/unowned</code> in the catalog.
                  </Text>
                )}
              </Flex>
            ) : (
              // Naming someone here who does not own it would be believed for
              // exactly as long as it takes to matter.
              <Text variant="body-x-small" color="secondary">
                {facts.ownershipProposal.candidates.length > 0
                  ? 'No clear owner: commits are spread too evenly to put a ' +
                    'name forward.'
                  : `No commits in the last ${facts.ownershipProposal.windowDays} days to derive one from.`}
              </Text>
            )}
            {facts.ownershipProposal.candidates.length > 1 && (
              <Text variant="body-x-small" color="secondary">
                Top contributors:{' '}
                {facts.ownershipProposal.candidates
                  .map(
                    candidate =>
                      `${candidate.name ?? candidate.email ?? 'unknown'} (${
                        candidate.commits
                      })`,
                  )
                  .join(' · ')}
              </Text>
            )}
          </Section>
        )}

        {facts.environments && (
          <Section title="Environments">
            {facts.environments.length > 0 ? (
              <div style={STAT_GRID}>
                {facts.environments.map(environment => (
                  <Stat
                    key={environment.name}
                    label={
                      environment.type
                        ? `${environment.name} · ${environment.type}`
                        : environment.name
                    }
                    value={timeAgo(environment.deployedAt) ?? EMPTY}
                    hint={
                      [
                        environment.releaseName,
                        shortHash(environment.commitHash),
                      ]
                        .filter(Boolean)
                        .join(' · ') || EMPTY
                    }
                  />
                ))}
              </div>
            ) : (
              // Almost always a naming mismatch rather than a repository that
              // never deploys, so the note says exactly what to change.
              <Text variant="body-x-small" color="secondary">
                No deployments recorded. Bitbucket only creates one when the
                deployment name in bitbucket-pipelines.yml exactly matches a
                configured environment name, case included.
              </Text>
            )}
          </Section>
        )}

        <Section title="Repository">
          <div style={STAT_GRID}>
            <Stat label="Project" value={facts.projectKey ?? EMPTY} />
            <Stat label="Default branch" value={facts.defaultBranch ?? EMPTY} />
            {/* Bitbucket reports no language for 94% of this estate, so the
                manifest-derived value is usually the only one available. */}
            <Stat
              label="Language"
              value={facts.language ?? facts.derivedLanguage ?? EMPTY}
            />
            <Stat label="Size" value={formatBytes(facts.sizeBytes) ?? EMPTY} />
            <Stat
              label="Visibility"
              value={facts.isPrivate ? 'Private' : 'Public'}
            />
          </div>
          {facts.techStack && facts.techStack.length > 0 && (
            <Field label="Technology stack">
              <Text variant="body-small">{facts.techStack.join(' · ')}</Text>
            </Field>
          )}
        </Section>

        <Flex
          gap="4"
          align="center"
          style={{
            flexWrap: 'wrap',
            justifyContent: 'space-between',
            borderTop: BORDER,
            paddingTop: '0.75rem',
          }}
        >
          <Link href={facts.url} target="_blank" rel="noreferrer">
            Open in Bitbucket
          </Link>
          <Text variant="body-x-small" color="secondary">
            Synchronised {timeAgo(facts.lastSyncedAt) ?? 'never'}
          </Text>
        </Flex>
      </Flex>
    );
  }

  return (
    <Card>
      <CardHeader>
        <Text variant="title-small">Repository activity</Text>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
