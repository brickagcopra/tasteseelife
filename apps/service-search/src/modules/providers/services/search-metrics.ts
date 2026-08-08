import { Inject, Injectable } from '@nestjs/common';
import type { SearchProvidersRequest } from '@taste-and-see/contracts';
import {
  type Counter,
  getMeter,
  type Histogram,
  type ObservableGauge,
} from '@taste-and-see/tracing';

import { SEARCH_BACKEND_TOKEN, type SearchBackend } from './search-backend';

const METER_NAME = 'service-search:search';

/** Sort strategy label — mirrors the contract's `SearchProvidersRequest['sort']`. */
export type SearchSortLabel = SearchProvidersRequest['sort'];

/** Whether a discovery query returned any hits. */
export type SearchQueryOutcome = 'ok' | 'empty';

/**
 * Indexer upsert outcome. The first three mirror the backend's
 * `UpsertOutcome`; `provider_id_mismatch` partitions the service-layer
 * defence-in-depth rejection (path `:providerId` ≠ `document.providerId`)
 * that never reaches the backend.
 */
export type SearchUpsertOutcome = 'created' | 'updated' | 'unchanged' | 'provider_id_mismatch';

/** Indexer delete outcome — mirrors the backend's `DeleteOutcome`. */
export type SearchDeleteOutcome = 'deleted' | 'not_found';

/**
 * service-search's domain Prometheus instruments (TS-111-followup-4).
 *
 * Three counters + one histogram span the public discovery surface and the
 * internal indexer surface; one observable gauge tracks index size:
 *
 *   - `search_provider_queries_total{outcome,sort,live_mode}` — every
 *     resolved discovery query, partitioned by whether it returned hits
 *     (`ok` / `empty`), the sort strategy, and whether the backend is the
 *     live Elasticsearch cluster or the Phase-1 in-memory stub. A rising
 *     `empty` rate at a given `sort` is the leading indicator of an
 *     over-narrow filter default or a stale/empty index.
 *   - `search_query_latency_seconds{sort,live_mode}` — discovery-query
 *     wall-clock latency, the signal behind the PDD §7.1 "search p95 <
 *     500ms" budget. Sliced by sort + backend mode so the stub-vs-live
 *     and relevance-vs-distance cost differences stay visible.
 *   - `search_provider_upserts_total{outcome}` — indexer upserts by
 *     outcome. A rising `unchanged` rate means the TS-053 indexer is
 *     re-delivering already-current docs (out-of-order or duplicate
 *     events); a non-zero `provider_id_mismatch` rate is a contract bug
 *     in the indexer's path/body construction.
 *   - `search_provider_deletes_total{outcome}` — indexer deletes by
 *     outcome (`deleted` first time, `not_found` on idempotent re-delete).
 *   - `search_index_size_docs` (observable gauge) — current indexed
 *     document count, read on each scrape via the backend's optional
 *     `documentCount()`. The capacity-planning signal behind PDD §27.
 *
 * Label cardinality is bounded by construction — `outcome`, `sort`, and
 * `live_mode` are all fixed string-literal / boolean-string unions, never
 * derived from a query or a provider id (CLAUDE.md §10 PII discipline: no
 * doc ids, no query text, no actor on metric labels).
 *
 * Instruments are created via `getMeter`, which returns a usable no-op
 * meter when `initMetrics` was never called — so this class is safe to
 * construct in unit tests without booting the SDK (the observable gauge's
 * `addCallback` is likewise a no-op). Mirrors the `WebhookMetrics` /
 * `JanitorMetrics` domain-instrument shape.
 */
@Injectable()
export class SearchMetrics {
  private readonly queries: Counter;
  private readonly queryLatency: Histogram;
  private readonly upserts: Counter;
  private readonly deletes: Counter;
  private readonly indexSize: ObservableGauge;

  constructor(@Inject(SEARCH_BACKEND_TOKEN) backend: SearchBackend) {
    const meter = getMeter(METER_NAME);
    this.queries = meter.createCounter('search_provider_queries_total', {
      description:
        'Total provider-discovery queries, by hit outcome, sort strategy, and backend mode',
    });
    this.queryLatency = meter.createHistogram('search_query_latency_seconds', {
      description: 'Provider-discovery query latency in seconds, by sort strategy and backend mode',
      unit: 's',
    });
    this.upserts = meter.createCounter('search_provider_upserts_total', {
      description: 'Total provider-index upserts by outcome',
    });
    this.deletes = meter.createCounter('search_provider_deletes_total', {
      description: 'Total provider-index deletes by outcome',
    });
    this.indexSize = meter.createObservableGauge('search_index_size_docs', {
      description: 'Current number of indexed provider documents',
    });
    // Observable: read the live count on each collection. The backend's
    // `documentCount` is optional — a live ES backend may omit it, in which
    // case the gauge records nothing (rather than 0, which would be a lie)
    // until that backend grows a cached count.
    this.indexSize.addCallback((result) => {
      const count = backend.documentCount?.();
      if (count !== undefined) result.observe(count);
    });
  }

  /** Record one resolved discovery query's outcome + latency. */
  recordQuery(input: {
    readonly outcome: SearchQueryOutcome;
    readonly sort: SearchSortLabel;
    readonly liveMode: boolean;
    readonly seconds: number;
  }): void {
    const liveMode = String(input.liveMode);
    this.queries.add(1, { outcome: input.outcome, sort: input.sort, live_mode: liveMode });
    this.queryLatency.record(input.seconds, { sort: input.sort, live_mode: liveMode });
  }

  /** Record one indexer upsert outcome. */
  recordUpsert(outcome: SearchUpsertOutcome): void {
    this.upserts.add(1, { outcome });
  }

  /** Record one indexer delete outcome. */
  recordDelete(outcome: SearchDeleteOutcome): void {
    this.deletes.add(1, { outcome });
  }
}
