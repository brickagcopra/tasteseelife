import { Injectable, Logger } from '@nestjs/common';
import {
  SEARCH_PERFORMED,
  type SearchFilterFacet,
  type SearchPerformed,
  type SearchProvidersRequest,
  type SearchProvidersResponse,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Filter-facet keys in their canonical (schema enum) order. The
 * projection walks this list so `appliedFilters` is deterministic — the
 * order does not depend on `Object.keys` insertion order of the request
 * body. Kept local to the producer (the contract owns the enum *values*;
 * the producer owns the *traversal order* used to build the payload).
 */
const FILTER_FACET_KEYS: readonly SearchFilterFacet[] = [
  'tiers',
  'statuses',
  'languages',
  'specialties',
  'cuisines',
  'dietaryExpertise',
  'certifications',
  'minRating',
  'providerIds',
];

/**
 * Pure projection: `(request, response, actor) → search.performed payload`.
 *
 * Exported so it can be unit-tested without any DI / Postgres. The
 * emitter below wraps it with eventId/clock generation + the best-effort
 * outbox append. Keeping the projection pure means every "what does the
 * event carry for this query" assertion is a plain function call.
 *
 * The `eventId` / `occurredAt` are supplied by the caller (the emitter
 * generates them once and threads them into BOTH the payload envelope
 * and the outbox column values, so the row's `event_id` matches the
 * payload's `eventId`).
 */
export function buildSearchPerformedPayload(input: {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actorUserId: string;
  readonly request: SearchProvidersRequest;
  readonly response: SearchProvidersResponse;
}): SearchPerformed {
  const { request, response } = input;
  const filters = request.filters;

  const appliedFilters = FILTER_FACET_KEYS.filter(
    (key) => filters !== undefined && filters[key] !== undefined,
  );

  return {
    eventId: input.eventId,
    occurredAt: input.occurredAt,
    actorUserId: input.actorUserId,
    queryText: request.query ?? null,
    sort: request.sort,
    hasGeo: request.geo !== undefined,
    appliedFilters,
    filterTiers: filters?.tiers ?? [],
    resultCount: response.hits.length,
    totalEstimate: response.totalEstimate,
    zeroResults: response.totalEstimate === 0,
    page: request.cursor === undefined ? 'first' : 'paged',
    liveMode: response.liveMode,
  };
}

/**
 * Emits the `search.performed` analytics event (TS-217-prep-1) after a
 * provider-discovery query resolves.
 *
 * **Best-effort by construction.** Provider search is a pure READ — there
 * is no business transaction to append the event atomically with (the
 * pattern every other outbox producer uses). So the emit runs OFF the
 * critical path: any failure (Postgres unreachable, the tenant-scope
 * gate, a payload that fails registry validation) is logged at `warn`
 * and swallowed. A family-portal search must never fail because the
 * analytics pipeline hiccuped — the event is telemetry feeding the
 * TS-217 search-relevance dashboard, not a correctness-bearing write.
 *
 * **Why the top-level client and not a transaction.** With no business
 * write to be atomic with, wrapping the single outbox INSERT in a
 * `$transaction` buys nothing but a round-trip. The append runs against
 * the DI-injected (tenant-scoped) `PrismaService`; during a search the
 * request carries a scoped frame (the endpoint sits behind
 * `AccessTokenGuard`), so the raw INSERT satisfies the gate the same way
 * the booking producer's append does.
 *
 * **TS-217-prep-4a — the caller mints the event id.** The `searchId` is
 * minted by the controller (so it can be returned on the search response
 * BEFORE the emit runs) and threaded in here, where it becomes the
 * event's envelope `eventId` AND the outbox row's `event_id`. The token
 * the client receives therefore matches the persisted event exactly, so
 * the downstream `search.result_clicked` (prep-4b) and `booking.created`
 * (prep-4c) correlation joins resolve to this row.
 */
@Injectable()
export class SearchAnalyticsEmitter {
  private readonly log = new Logger(SearchAnalyticsEmitter.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
  ) {}

  async emitSearchPerformed(input: {
    readonly searchId: string;
    readonly actorUserId: string;
    readonly request: SearchProvidersRequest;
    readonly response: SearchProvidersResponse;
  }): Promise<void> {
    const eventId = input.searchId;
    const occurredAt = new Date();
    const payload = buildSearchPerformedPayload({
      eventId,
      occurredAt: occurredAt.toISOString(),
      actorUserId: input.actorUserId,
      request: input.request,
      response: input.response,
    });

    try {
      const result = await this.outbox.append(this.prisma as unknown as OutboxRawExecutor, {
        eventName: SEARCH_PERFORMED,
        payload,
        eventId,
        occurredAt,
      });
      if (result.kind !== 'appended') {
        this.log.warn(
          `search.performed payload failed registry validation (best-effort, dropped): ${result.issues
            .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
            .join('; ')}`,
        );
      }
    } catch (err) {
      // Best-effort: never let analytics telemetry break a search.
      this.log.warn(
        `search.performed append failed (best-effort, dropped): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
