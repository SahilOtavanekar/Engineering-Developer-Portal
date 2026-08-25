import type { ReactNode } from 'react';
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
import { BAND_LABEL, BAND_TEXT } from '../../bands';
import { useRepositoryFacts } from '../../useRepositoryFacts';

const EMPTY = '—';

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

    body = (
      <Flex direction="column" gap="5">
        {score && (
          <Flex gap="6" align="center" style={{ flexWrap: 'wrap' }}>
            <Field label="Health score">
              <Flex gap="2" align="baseline">
                <Text
                  variant="title-large"
                  style={{ color: BAND_TEXT[score.band] }}
                >
                  {score.total}
                </Text>
                <Text variant="body-small" color="secondary">
                  / 100
                </Text>
              </Flex>
            </Field>
            <Field label="Band">
              <Text
                variant="title-medium"
                style={{ color: BAND_TEXT[score.band] }}
              >
                {BAND_LABEL[score.band] ?? score.band}
              </Text>
            </Field>
            <Field label="Measured">
              <Text variant="title-medium">
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
          <Text variant="body-x-small" color="secondary">
            Provisional. Scored over the metrics that can be measured today —
            the rest are not yet wired up, and band thresholds are placeholders
            pending sign-off.
          </Text>
        )}

        {score && (
          <Flex direction="column" gap="2">
            {score.breakdown.map(metric => (
              <Flex
                key={metric.id}
                gap="3"
                align="baseline"
                style={{ flexWrap: 'wrap' }}
              >
                <Text variant="body-small">{metric.title}</Text>
                <Text variant="body-x-small" color="secondary">
                  {metric.available
                    ? `${metric.points} / ${metric.weight} — ${metric.detail}`
                    : `not measured yet (worth ${metric.weight})`}
                </Text>
              </Flex>
            ))}
          </Flex>
        )}

        <Flex gap="6" style={{ flexWrap: 'wrap' }}>
          <Field label={`Commits (${window})`}>
            <Text variant="title-medium">{facts.activity.commits}</Text>
          </Field>
          <Field label={`Authors (${window})`}>
            <Text variant="title-medium">{facts.activity.authors}</Text>
          </Field>
          <Field label="Last commit">
            <Text variant="title-medium">
              {timeAgo(facts.lastCommitAt) ?? 'Never'}
            </Text>
          </Field>
        </Flex>

        <Flex gap="6" style={{ flexWrap: 'wrap' }}>
          <Field label="Project">
            <Text>{facts.projectKey ?? EMPTY}</Text>
          </Field>
          <Field label="Default branch">
            <Text>{facts.defaultBranch ?? EMPTY}</Text>
          </Field>
          <Field label="Language">
            <Text>
              {/* Bitbucket reports no language for 94% of this estate, so the
                  manifest-derived value is usually the only one available. */}
              {facts.language ?? facts.derivedLanguage ?? EMPTY}
            </Text>
          </Field>
          <Field label="Size">
            <Text>{formatBytes(facts.sizeBytes) ?? EMPTY}</Text>
          </Field>
          <Field label="Visibility">
            <Text>{facts.isPrivate ? 'Private' : 'Public'}</Text>
          </Field>
        </Flex>

        <Flex gap="6" style={{ flexWrap: 'wrap' }}>
          {facts.reviews && facts.reviews.merged > 0 && (
            <Field label={`Reviewed (${window})`}>
              <Text>
                {facts.reviews.approved} of {facts.reviews.merged} merged PRs
              </Text>
            </Field>
          )}
          {facts.reviews?.medianMergeHours !== undefined && (
            <Field label="Median merge time">
              <Text>{formatHours(facts.reviews.medianMergeHours)}</Text>
            </Field>
          )}
          {facts.reviews && facts.reviews.open > 0 && (
            <Field label="Open PRs">
              <Text>{facts.reviews.open}</Text>
            </Field>
          )}
          {facts.branches && facts.branches.total > 0 && (
            <Field label="Stale branches">
              <Text>
                {facts.branches.stale} of {facts.branches.total}
              </Text>
            </Field>
          )}
        </Flex>

        {facts.branches && facts.branches.stalest.length > 0 && (
          <Field label="Longest abandoned">
            <Text variant="body-small" color="secondary">
              {facts.branches.stalest
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

        {facts.ownershipProposal && (
          <Flex direction="column" gap="2">
            <Text variant="body-x-small" color="secondary">
              Suggested owner — not confirmed
            </Text>
            {facts.ownershipProposal.proposed ? (
              <>
                <Text variant="title-medium">
                  {facts.ownershipProposal.proposed.name ??
                    facts.ownershipProposal.proposed.email ??
                    EMPTY}
                </Text>
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
              </>
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
          </Flex>
        )}

        {facts.environments && (
          <Flex direction="column" gap="2">
            <Text variant="body-x-small" color="secondary">
              Environments
            </Text>
            {facts.environments.length > 0 ? (
              <Flex gap="6" style={{ flexWrap: 'wrap' }}>
                {facts.environments.map(environment => (
                  <Field
                    key={environment.name}
                    label={
                      environment.type
                        ? `${environment.name} · ${environment.type}`
                        : environment.name
                    }
                  >
                    <Text variant="title-medium">
                      {timeAgo(environment.deployedAt) ?? EMPTY}
                    </Text>
                    <Text variant="body-x-small" color="secondary">
                      {[
                        environment.releaseName,
                        shortHash(environment.commitHash),
                      ]
                        .filter(Boolean)
                        .join(' · ') || EMPTY}
                    </Text>
                  </Field>
                ))}
              </Flex>
            ) : (
              // Almost always a naming mismatch rather than a repository that
              // never deploys, so the note says exactly what to change.
              <Text variant="body-x-small" color="secondary">
                No deployments recorded. Bitbucket only creates one when the
                deployment name in bitbucket-pipelines.yml exactly matches a
                configured environment name, case included.
              </Text>
            )}
          </Flex>
        )}

        {facts.techStack && facts.techStack.length > 0 && (
          <Field label="Technology stack">
            <Text variant="body-small">{facts.techStack.join(' · ')}</Text>
          </Field>
        )}

        <Flex gap="4" align="center" style={{ flexWrap: 'wrap' }}>
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
