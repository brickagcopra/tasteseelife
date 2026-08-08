import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type DeleteProviderDocumentResponse,
  type ProviderDiscoveryDocument,
  type UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

/**
 * Thrown when the HTTP call to service-search fails or returns a
 * non-2xx response. The consumer SDK catches the throw, records a
 * failure in the dedup store, and retries on the next delivery cycle.
 */
export class SearchIndexClientError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly status: number | 'network',
    public readonly detail: string,
  ) {
    super(`SearchIndexClient: ${detail} (providerId=${providerId}, status=${status})`);
    this.name = 'SearchIndexClientError';
  }
}

/**
 * HTTP client for service-search's internal index-ingest endpoints
 * (TS-111). Two methods:
 *
 *   `upsert(document)` → `UpsertProviderDocumentResponse`
 *   `remove(providerId)` → `DeleteProviderDocumentResponse`
 *
 * Both use Node's built-in `fetch` (Node 22+) with an
 * `AbortController`-backed timeout.
 *
 * The client doesn't validate the response bodies — service-search's
 * own contract testing covers that surface; double-validating here
 * would add round-trip cost without catching a class of bug the
 * receiver's own validation misses.
 */
@Injectable()
export class SearchIndexClient {
  private readonly logger = new Logger(SearchIndexClient.name);

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  async upsert(document: ProviderDiscoveryDocument): Promise<UpsertProviderDocumentResponse> {
    const url = `${this.env.SEARCH_SERVICE_BASE_URL.replace(/\/$/, '')}/api/v1/internal/search/providers/${encodeURIComponent(document.providerId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.SEARCH_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          [this.env.SEARCH_INDEX_HEADER_NAME]: this.env.SEARCH_INDEX_API_KEY,
        },
        body: JSON.stringify({ document }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new SearchIndexClientError(
        document.providerId,
        'network',
        cause instanceof Error ? cause.message : 'unknown network error',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        { providerId: document.providerId, status: response.status, detail: detail.slice(0, 200) },
        'search-index.upsert non-2xx',
      );
      throw new SearchIndexClientError(
        document.providerId,
        response.status,
        'non-2xx response from service-search',
      );
    }

    return (await response.json()) as UpsertProviderDocumentResponse;
  }

  async remove(providerId: string): Promise<DeleteProviderDocumentResponse> {
    const url = `${this.env.SEARCH_SERVICE_BASE_URL.replace(/\/$/, '')}/api/v1/internal/search/providers/${encodeURIComponent(providerId)}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.env.SEARCH_REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'DELETE',
        headers: {
          accept: 'application/json',
          [this.env.SEARCH_INDEX_HEADER_NAME]: this.env.SEARCH_INDEX_API_KEY,
        },
        signal: controller.signal,
      });
    } catch (cause) {
      throw new SearchIndexClientError(
        providerId,
        'network',
        cause instanceof Error ? cause.message : 'unknown network error',
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.warn(
        { providerId, status: response.status, detail: detail.slice(0, 200) },
        'search-index.remove non-2xx',
      );
      throw new SearchIndexClientError(
        providerId,
        response.status,
        'non-2xx response from service-search',
      );
    }

    return (await response.json()) as DeleteProviderDocumentResponse;
  }
}
