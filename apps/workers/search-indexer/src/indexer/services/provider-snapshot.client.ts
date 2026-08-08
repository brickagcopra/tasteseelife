import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_DISCOVERY_ID_MAX_LENGTH,
  ProviderDiscoverySnapshotResponseSchema,
  type ProviderDiscoverySnapshotResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

/**
 * Result returned by `ProviderSnapshotClient.fetch`. Mirrors the
 * service-provider contract's discriminated-union:
 *
 *   - `kind: 'found'`     — the full `ProviderDiscoveryDocument`.
 *   - `kind: 'not_found'` — provider missing or soft-deleted. The
 *                           indexer translates this into a DELETE.
 *
 * Plus two transport-layer failures that the handler treats as
 * retriable (the consumer SDK re-delivers on throw):
 *
 *   - `kind: 'invalid_request'` — providerId failed the contract's
 *     id-regex check before any network IO. Logged + skipped (XACK
 *     without retry — the event is malformed and a retry won't fix
 *     it). The handler swallows this rather than throws.
 *
 *   - The HTTP transport itself surfaces failures as a thrown
 *     `ProviderSnapshotClientError` so the consumer SDK's retry +
 *     dead-letter machinery kicks in.
 */
export type ProviderSnapshotResult =
  | { readonly kind: 'found'; readonly response: ProviderDiscoverySnapshotResponse }
  | { readonly kind: 'invalid_request'; readonly message: string };

/**
 * Thrown when the HTTP call to service-provider fails or returns a
 * non-2xx response. The consumer SDK catches the throw, records a
 * failure in the dedup store, and retries on the next delivery cycle.
 */
export class ProviderSnapshotClientError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly status: number | 'network',
    public readonly detail: string,
  ) {
    super(`ProviderSnapshotClient: ${detail} (providerId=${providerId}, status=${status})`);
    this.name = 'ProviderSnapshotClientError';
  }
}

/**
 * HTTP client for service-provider's internal discovery-snapshot
 * endpoint (TS-053). One method:
 *
 *   `fetch(providerId)` → `ProviderSnapshotResult`
 *
 * The client uses Node's built-in `fetch` (Node 22+) with an
 * `AbortController`-backed timeout so we never hang on a stalled
 * upstream. The response body is parsed against
 * `ProviderDiscoverySnapshotResponseSchema` so a malformed payload
 * surfaces as a typed transport error rather than as a partially-
 * shaped doc reaching the index.
 */
@Injectable()
export class ProviderSnapshotClient {
  private readonly logger = new Logger(ProviderSnapshotClient.name);
  private readonly providerIdRegex = /^[a-zA-Z0-9_-]+$/;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async fetch(providerId: string): Promise<ProviderSnapshotResult> {
    if (
      providerId.length === 0 ||
      providerId.length > PROVIDER_DISCOVERY_ID_MAX_LENGTH ||
      !this.providerIdRegex.test(providerId)
    ) {
      return {
        kind: 'invalid_request',
        message: `providerId failed validation: '${providerId}'`,
      };
    }

    const url = `${this.env.PROVIDER_SERVICE_BASE_URL.replace(/\/$/, '')}/api/v1/internal/providers/${encodeURIComponent(providerId)}/discovery-snapshot`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.PROVIDER_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          [this.env.PROVIDER_DISCOVERY_INTERNAL_HEADER_NAME]:
            this.env.PROVIDER_DISCOVERY_INTERNAL_API_KEY,
        },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new ProviderSnapshotClientError(
        providerId,
        'network',
        cause instanceof Error ? cause.message : 'unknown network error',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Read the body for the trace log but DON'T leak it to the
      // outer error — bodies can carry sensitive identifiers.
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        { providerId, status: response.status, detail: detail.slice(0, 200) },
        'provider-snapshot.fetch non-2xx',
      );
      throw new ProviderSnapshotClientError(
        providerId,
        response.status,
        `non-2xx response from service-provider`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ProviderSnapshotClientError(
        providerId,
        response.status,
        cause instanceof Error ? `body parse failed: ${cause.message}` : 'body parse failed',
      );
    }

    const parsed = ProviderDiscoverySnapshotResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ProviderSnapshotClientError(
        providerId,
        response.status,
        `response schema violation: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')}`,
      );
    }

    return { kind: 'found', response: parsed.data };
  }
}
