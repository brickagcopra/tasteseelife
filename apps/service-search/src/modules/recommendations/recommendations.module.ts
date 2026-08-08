import { Module } from '@nestjs/common';

import { InternalSharedSecretGuard } from '../../common/guards/internal-shared-secret.guard';
import { ProvidersModule } from '../providers/providers.module';

import { RecommendationsController } from './controllers/recommendations.controller';
import { RecommendationsService } from './services/recommendations.service';

/**
 * TS-213 match-recommendations module. Wires the internal-shared-secret-
 * pinned scoring endpoint + the thin service that delegates to the
 * configured `SearchBackend`.
 *
 * Imports `ProvidersModule` to consume its exported `SEARCH_BACKEND_TOKEN`
 * (the singleton `InMemorySearchBackend` in Phase 1) — the recommendation
 * scoring reads the same in-memory provider-document store the public
 * search path queries. The live ES swap (TS-111-followup-1) changes only
 * the backend binding; this module is untouched.
 */
@Module({
  imports: [ProvidersModule],
  controllers: [RecommendationsController],
  providers: [RecommendationsService, InternalSharedSecretGuard],
})
export class RecommendationsModule {}
