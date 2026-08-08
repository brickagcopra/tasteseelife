import { Module } from '@nestjs/common';

import { InternalSharedSecretGuard } from '../../common/guards/internal-shared-secret.guard';
import { FeaturedPlacementsModule } from '../featured-placements/featured-placements.module';
import { RankingConfigModule } from '../ranking-config/ranking-config.module';
import { ProviderIndexController } from './controllers/provider-index.controller';
import { ProviderSearchController } from './controllers/provider-search.controller';
import { SearchClicksController } from './controllers/search-clicks.controller';
import { InMemorySearchBackend } from './services/in-memory-search-backend.service';
import { ProviderSearchService } from './services/provider-search.service';
import { SearchAnalyticsEmitter } from './services/search-analytics.emitter';
import { SearchMetrics } from './services/search-metrics';
import { SearchClickEmitter } from './services/search-click.emitter';
import { SEARCH_BACKEND_TOKEN, type SearchBackend } from './services/search-backend';
import { SponsoredListingsClient } from './services/sponsored-listings.client';

/**
 * Wires the public-search + internal-index controllers and the active
 * `SearchBackend` implementation.
 *
 * **Phase 1 binding**: `SEARCH_BACKEND_TOKEN` resolves to the singleton
 * `InMemorySearchBackend`. TS-111-followup-1 swaps the factory for one
 * that constructs a live `@elastic/elasticsearch`-backed implementation
 * when the env carries an `ELASTICSEARCH_NODE_URL`. No controller or
 * service code changes when the swap lands — the interface contract is
 * the only coupling.
 *
 * `InMemorySearchBackend` is also exposed by class (not just by token)
 * so admin tooling (TS-127) can seed canned data into the index during
 * dev / staging walkthroughs.
 *
 * `AccessTokenGuard` is no longer listed under `providers` — TS-052-followup-11a
 * lifted it into `@taste-and-see/nest-auth`'s `NestAuthModule`, which is
 * `@Global()` so the guard is auto-provided across the entire module tree.
 * `InternalSharedSecretGuard` stays — it's service-specific scaffolding
 * for the TS-053 search-indexer worker's PUT/DELETE shared-secret pin.
 */
@Module({
  imports: [RankingConfigModule, FeaturedPlacementsModule],
  controllers: [ProviderSearchController, SearchClicksController, ProviderIndexController],
  providers: [
    InMemorySearchBackend,
    {
      provide: SEARCH_BACKEND_TOKEN,
      useExisting: InMemorySearchBackend,
    },
    ProviderSearchService,
    // TS-111-followup-4 — domain Prometheus instruments (query / upsert /
    // delete counters, query-latency histogram, index-size gauge). Injects
    // the `SEARCH_BACKEND_TOKEN` backend for the observable index-size gauge.
    SearchMetrics,
    // TS-218b — outbound client for the service-ads sponsored-listings
    // resolve. Injects the `@Global()` `ENV_TOKEN`; gated off (no-op) until
    // `ADS_SERVICE_BASE_URL` is configured, and fail-open on every error.
    SponsoredListingsClient,
    // TS-217-prep-1 — best-effort `search.performed` analytics emitter.
    // Injects the `@Global()` `OutboxService` + the `@Global()`
    // `PrismaService`, so no extra module import is needed here.
    SearchAnalyticsEmitter,
    // TS-217-prep-4b — best-effort `search.result_clicked` emitter (CTR
    // telemetry). Same `@Global()` injection shape as the search.performed
    // emitter.
    SearchClickEmitter,
    InternalSharedSecretGuard,
  ],
  exports: [SEARCH_BACKEND_TOKEN, ProviderSearchService, InMemorySearchBackend],
})
export class ProvidersModule {}

// Re-export the interface type so the rest of the app can DI against
// the abstraction.
export type { SearchBackend };
