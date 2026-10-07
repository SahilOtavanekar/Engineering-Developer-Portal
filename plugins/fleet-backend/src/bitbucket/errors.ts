/**
 * Raised when the Bitbucket API returns a non-success status. Carries the
 * status so callers can distinguish retryable failures (429, 5xx) from
 * permanent ones (401, 403, 404). The client has already retried the
 * retryable ones by the time this reaches a caller.
 */
export class BitbucketApiError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, body: string) {
    super(
      `Bitbucket API request failed: ${status} ${url}${
        body ? ` :: ${body.replace(/\s+/g, ' ').slice(0, 300)}` : ''
      }`,
    );
    this.name = 'BitbucketApiError';
    this.status = status;
    this.url = url;
  }

  /** 429 and 5xx are worth retrying; client errors are not. */
  get isRetryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

/**
 * Bitbucket is still refusing with 429 after the client's retries.
 *
 * Its own type because the right response is different from any other
 * failure: the quota belongs to the credential, not to the repository being
 * asked about, so every remaining repository in the pass will get the same
 * answer. A pass that meets this stops, rather than failing each repository in
 * turn -- measured 2026-09-27, when one kept going and turned 4 failures into
 * 19 while spending the quota it was waiting for.
 */
export class BitbucketRateLimitError extends BitbucketApiError {
  constructor(url: string, body: string) {
    super(429, url, body);
    this.name = 'BitbucketRateLimitError';
  }
}
