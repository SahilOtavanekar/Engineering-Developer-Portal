/**
 * Raised when the Bitbucket API returns a non-success status. Carries the
 * status so callers can distinguish retryable failures (429, 5xx) from
 * permanent ones (401, 403, 404) once retry logic arrives.
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
