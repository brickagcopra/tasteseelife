import { Injectable, Logger } from '@nestjs/common';

import { ProviderSnapshotClient } from './provider-snapshot.client';
import { SearchIndexClient } from './search-index.client';

/**
 * Categorical outcome of a single projection. Returned by `project`
 * so handlers + tests can assert on the result without scraping log
 * lines.
 *
 *   - `upserted`           — full doc PUT, service-search accepted
 *                            (created / updated / unchanged).
 *   - `removed`            — service-provider returned `not_found`,
 *                            the worker issued a DELETE.
 *   - `invalid_provider_id` — the event carried a malformed
 *                            providerId; the worker skipped without
 *                            calling service-provider. The consumer
 *                            SDK XACKs without retry.
 *
 * Transport-layer failures throw; the consumer SDK's retry +
 * dead-letter machinery handles them.
 */
export type ProjectionOutcome =
  | {
      readonly kind: 'upserted';
      readonly providerId: string;
      readonly outcome: 'created' | 'updated' | 'unchanged';
    }
  | {
      readonly kind: 'removed';
      readonly providerId: string;
      readonly outcome: 'deleted' | 'not_found';
    }
  | { readonly kind: 'invalid_provider_id'; readonly providerId: string; readonly message: string };

/**
 * `ProjectionOrchestratorService` — the search-indexer worker's core
 * read-side projection (TS-053).
 *
 * Given a `providerId` (extracted from a provider domain event), the
 * orchestrator:
 *
 *   1. GETs the discovery snapshot from service-provider.
 *      - `kind: 'found'`     → PUT the doc to service-search.
 *      - `kind: 'not_found'` → DELETE the doc from service-search.
 *   2. Returns a `ProjectionOutcome` reflecting which path fired.
 *
 * All three provider events (`tier_changed`, `certification_granted`,
 * `certification_revoked`) drive the same orchestration — only the
 * `providerId` is event-specific. Keeping the orchestration in one
 * service keeps each handler trivially thin.
 *
 * **Idempotency** is layered:
 *   - service-search's `upsert` dedupes on `(providerId, sourceUpdatedAt)`.
 *   - The consumer SDK's dedup store dedupes on `(consumerGroup, eventId)`.
 *   - The orchestrator itself is stateless — every call freshly
 *     fetches the current snapshot.
 *
 * The orchestrator never short-circuits on a stale event because the
 * source-of-truth is always the snapshot, not the event payload.
 */
@Injectable()
export class ProjectionOrchestratorService {
  private readonly logger = new Logger(ProjectionOrchestratorService.name);

  constructor(
    private readonly snapshotClient: ProviderSnapshotClient,
    private readonly indexClient: SearchIndexClient,
  ) {}

  async project(providerId: string): Promise<ProjectionOutcome> {
    const snapshot = await this.snapshotClient.fetch(providerId);

    if (snapshot.kind === 'invalid_request') {
      this.logger.warn(
        { providerId, message: snapshot.message },
        'projection.skip invalid_provider_id',
      );
      return {
        kind: 'invalid_provider_id',
        providerId,
        message: snapshot.message,
      };
    }

    if (snapshot.response.kind === 'not_found') {
      const result = await this.indexClient.remove(providerId);
      this.logger.log({ providerId, outcome: result.outcome }, 'projection.removed');
      return { kind: 'removed', providerId, outcome: result.outcome };
    }

    const result = await this.indexClient.upsert(snapshot.response.document);
    this.logger.log(
      {
        providerId,
        outcome: result.outcome,
        sourceUpdatedAt: snapshot.response.document.sourceUpdatedAt,
      },
      'projection.upserted',
    );
    return { kind: 'upserted', providerId, outcome: result.outcome };
  }
}
