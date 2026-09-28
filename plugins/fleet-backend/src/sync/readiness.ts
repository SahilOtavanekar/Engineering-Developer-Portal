import type {
  SyncStateRecord,
  SyncStateStore,
} from '../database/SyncStateStore';

/**
 * What a pass records when it **finished** but some of its items failed.
 *
 * Every pass marks itself failed if even one repository failed, which is right
 * for backoff but wrong for readiness: a pass that stored facts for 102 of 106
 * repositories has finished, and treating it as never-run would let a single
 * permanently broken repository block scoring on a fresh install for ever. So
 * the message is built here, beside the only code that parses it, rather than
 * as a string literal in each service where one edit would silently break the
 * match.
 */
export type PartialFailureKind =
  | 'repositories failed'
  | 'pull requests could not be measured';

export function partialFailure(
  failures: number,
  kind: PartialFailureKind = 'repositories failed',
): Error {
  return new Error(`${failures} ${kind}`);
}

const PARTIAL_FAILURE =
  /^(\d+) (repositories failed|pull requests could not be measured)$/;

/**
 * Whether a pass has finished at least one run, successful or partly failed.
 *
 * Deliberately NOT "is it currently healthy": `last_success_at` is never
 * cleared, so once a pass has succeeded this stays true through later
 * failures -- the facts it stored are still there. What it rejects is a pass
 * that has never run, is running for the first time (an attempt with neither a
 * success nor an error), or has only ever crashed outright.
 *
 * A partial failure covering every live repository stored nothing, so it does
 * not count: 106 of 106 repositories failing is a pass that did not finish.
 */
export function hasCompletedOnce(
  state: SyncStateRecord | undefined,
  liveRepositories: number,
): boolean {
  if (!state) return false;
  if (state.last_success_at) return true;
  const match = state.last_error
    ? PARTIAL_FAILURE.exec(state.last_error)
    : null;
  if (!match) return false;
  if (match[2] === 'repositories failed') {
    return Number(match[1]) < liveRepositories;
  }
  return true;
}

/** The resources, of those given, that have not yet finished a run. */
export async function incompletePrerequisites(
  syncState: SyncStateStore,
  resources: string[],
  liveRepositories: number,
): Promise<string[]> {
  const waiting: string[] = [];
  for (const resource of resources) {
    if (!hasCompletedOnce(await syncState.get(resource), liveRepositories)) {
      waiting.push(resource);
    }
  }
  return waiting;
}
