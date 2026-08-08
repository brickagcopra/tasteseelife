import { Logger } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Thrown when an internal cross-service call fails at the transport layer
 * — a network error, a timeout, a non-2xx response, or a response that
 * violates the published contract. The orchestrator catches these
 * per-unit (per household / per recipient) so one bad hop never aborts
 * the whole monthly run.
 */
export class InternalHttpError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number | 'network' | 'timeout' | 'schema',
    public readonly detail: string,
  ) {
    super(`${service}: ${detail} (status=${status})`);
    this.name = 'InternalHttpError';
  }
}

export interface InternalRequestOptions<T> {
  readonly service: string;
  readonly url: string;
  readonly method: 'GET' | 'POST';
  readonly headerName: string;
  readonly apiKey: string;
  readonly timeoutMs: number;
  readonly schema: ZodType<T>;
  readonly logger: Logger;
  readonly body?: unknown;
}

/**
 * Make one shared-secret-pinned internal call and return the parsed,
 * contract-validated body. Uses Node's built-in `fetch` (Node 22+) with
 * an `AbortController`-backed timeout so a stalled upstream never hangs
 * the run. The body is parsed against the supplied Zod schema so a
 * malformed payload surfaces as a typed `InternalHttpError` rather than
 * propagating a half-shaped object. Response bodies are NEVER echoed into
 * the thrown error (they can carry PII) — only a truncated trace log.
 */
export async function internalRequest<T>(opts: InternalRequestOptions<T>): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs);

  const headers: Record<string, string> = {
    accept: 'application/json',
    [opts.headerName]: opts.apiKey,
  };
  if (opts.method === 'POST') {
    headers['content-type'] = 'application/json';
  }

  let response: Response;
  try {
    response = await fetch(opts.url, {
      method: opts.method,
      headers,
      signal: controller.signal,
      ...(opts.body !== undefined && { body: JSON.stringify(opts.body) }),
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === 'AbortError';
    throw new InternalHttpError(
      opts.service,
      aborted ? 'timeout' : 'network',
      cause instanceof Error ? cause.message : 'unknown transport error',
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    opts.logger.warn(
      { service: opts.service, status: response.status, detail: detail.slice(0, 200) },
      'internal call returned non-2xx',
    );
    throw new InternalHttpError(opts.service, response.status, 'non-2xx response');
  }

  let raw: unknown;
  try {
    raw = await response.json();
  } catch (cause) {
    throw new InternalHttpError(
      opts.service,
      'schema',
      cause instanceof Error ? `body parse failed: ${cause.message}` : 'body parse failed',
    );
  }

  const parsed = opts.schema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalHttpError(
      opts.service,
      'schema',
      `response schema violation: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/** Strip a trailing slash from a base URL before path concatenation. */
export function trimBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}
