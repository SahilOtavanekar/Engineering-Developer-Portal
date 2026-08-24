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
import { formatBytes, timeAgo } from '../../format';
import { BAND_COLOR, BAND_LABEL } from '../../bands';
import { useRepositoryFacts } from '../../useRepositoryFacts';

const EMPTY = '—';

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
                  style={{ color: BAND_COLOR[score.band] }}
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
                style={{ color: BAND_COLOR[score.band] }}
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
