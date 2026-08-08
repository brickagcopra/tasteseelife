import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SearchBackend } from './search-backend';
import { SearchMetrics } from './search-metrics';

/**
 * Full-surface tests for the domain search instruments (TS-111-followup-4):
 * boot a MeterProvider, record through the public methods (and trigger the
 * observable index-size gauge via `serializeMetrics`'s inline collect), and
 * assert the serialized Prometheus document carries the expected series +
 * labels. This proves the instruments are wired to the global meter and that
 * the label sets are exactly what the dashboards/alerts query. Mirrors the
 * WebhookMetrics / JanitorMetrics shape.
 *
 * A long export interval (1h) keeps the periodic reader's background sweep
 * from racing the inline `collect()` inside `serializeMetrics()`.
 */

/** Minimal backend stub exposing only the count the gauge reads. */
function fakeBackend(documentCount?: () => number | undefined): SearchBackend {
  const stub: Partial<SearchBackend> = {};
  if (documentCount !== undefined) {
    stub.documentCount = documentCount;
  }
  return stub as SearchBackend;
}

describe('SearchMetrics', () => {
  let metrics: SearchMetrics;

  beforeEach(() => {
    initMetrics({
      service: 'service-search-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    metrics = new SearchMetrics(fakeBackend(() => 3));
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('records a query with outcome + sort + live_mode labels and a latency sample', async () => {
    metrics.recordQuery({ outcome: 'ok', sort: 'relevance', liveMode: false, seconds: 0.012 });

    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE search_provider_queries_total counter/);
    expect(out).toMatch(
      /search_provider_queries_total\{[^}]*outcome="ok"[^}]*sort="relevance"[^}]*live_mode="false"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /search_query_latency_seconds_count\{[^}]*sort="relevance"[^}]*live_mode="false"[^}]*\} 1/,
    );
  });

  it('partitions empty vs ok and live vs stub on distinct query series', async () => {
    metrics.recordQuery({ outcome: 'empty', sort: 'distance', liveMode: true, seconds: 0.05 });
    metrics.recordQuery({ outcome: 'ok', sort: 'rating', liveMode: false, seconds: 0.02 });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /search_provider_queries_total\{[^}]*outcome="empty"[^}]*sort="distance"[^}]*live_mode="true"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /search_provider_queries_total\{[^}]*outcome="ok"[^}]*sort="rating"[^}]*live_mode="false"[^}]*\} 1/,
    );
  });

  it('records upsert outcomes on distinct series', async () => {
    metrics.recordUpsert('created');
    metrics.recordUpsert('created');
    metrics.recordUpsert('unchanged');
    metrics.recordUpsert('provider_id_mismatch');

    const out = await serializeMetrics();
    expect(out).toMatch(/search_provider_upserts_total\{[^}]*outcome="created"[^}]*\} 2/);
    expect(out).toMatch(/search_provider_upserts_total\{[^}]*outcome="unchanged"[^}]*\} 1/);
    expect(out).toMatch(
      /search_provider_upserts_total\{[^}]*outcome="provider_id_mismatch"[^}]*\} 1/,
    );
  });

  it('records delete outcomes (deleted / not_found)', async () => {
    metrics.recordDelete('deleted');
    metrics.recordDelete('not_found');

    const out = await serializeMetrics();
    expect(out).toMatch(/search_provider_deletes_total\{[^}]*outcome="deleted"[^}]*\} 1/);
    expect(out).toMatch(/search_provider_deletes_total\{[^}]*outcome="not_found"[^}]*\} 1/);
  });

  it('observes the index size from the backend documentCount on each scrape', async () => {
    const out = await serializeMetrics();
    expect(out).toMatch(/# TYPE search_index_size_docs gauge/);
    expect(out).toMatch(/search_index_size_docs(\{[^}]*\})? 3/);
  });

  it('omits the index-size gauge when the backend has no documentCount', async () => {
    await shutdownMetrics();
    initMetrics({
      service: 'service-search-test',
      env: 'test',
      version: '0.0.0-test',
      exportIntervalMillis: 3_600_000,
    });
    const noCount = new SearchMetrics(fakeBackend());
    noCount.recordUpsert('created'); // keep at least one series so the doc isn't empty

    const out = await serializeMetrics();
    expect(out).not.toMatch(/search_index_size_docs/);
  });

  it('constructs without a booted SDK (no-op meter fallback)', async () => {
    await shutdownMetrics();
    const offline = new SearchMetrics(fakeBackend(() => 0));
    expect(() =>
      offline.recordQuery({ outcome: 'ok', sort: 'relevance', liveMode: false, seconds: 0.01 }),
    ).not.toThrow();
    expect(() => offline.recordUpsert('created')).not.toThrow();
    expect(() => offline.recordDelete('not_found')).not.toThrow();
  });
});
