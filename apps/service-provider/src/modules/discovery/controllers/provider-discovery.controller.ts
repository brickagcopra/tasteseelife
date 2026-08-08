import { Controller, Get, HttpCode, HttpStatus, Inject, Param, UseGuards } from '@nestjs/common';
import {
  PROVIDER_DISCOVERY_ID_MAX_LENGTH,
  type ProviderDiscoverySnapshotResponse,
} from '@taste-and-see/contracts';
import { z } from 'zod';

import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ProviderDiscoverySharedSecretGuard } from '../../../common/guards/provider-discovery-shared-secret.guard';
import { ProviderDiscoveryService } from '../services/provider-discovery.service';

/**
 * Internal provider-discovery snapshot surface (TS-053).
 *
 * One read endpoint:
 *
 *   `GET /api/v1/internal/providers/:providerId/discovery-snapshot`
 *     → 200 with a `ProviderDiscoverySnapshotResponse` discriminated
 *       union (`kind: 'found'` carries the doc; `kind: 'not_found'`
 *       tells the indexer to issue a DELETE).
 *
 * Pinned by `ProviderDiscoverySharedSecretGuard` (a shared
 * `PROVIDER_DISCOVERY_INTERNAL_API_KEY` header). NetworkPolicy
 * (TS-151) further restricts the route to in-cluster callers.
 *
 * The endpoint is GET-only and idempotent — no Idempotency-Key
 * required.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The endpoint
 * runs BEFORE any `requestContext` exists — it pins the shared-secret
 * header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. The body is
 * wrapped in `runWithoutTenantContext(..., 'internal-provider-discovery-snapshot', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The search-
 * indexer worker is the sole consumer of this surface and operates
 * cross-tenant by design (it projects every provider's discovery doc
 * into Elasticsearch); the exempt frame is correct here.
 */
/**
 * Declared ABOVE the controller, not below it: the `@Param(...)` decorator
 * evaluates while the class is being defined, so a `const` further down the
 * module is still in its temporal dead zone at that moment and the process
 * dies at import with "Cannot access 'PathProviderIdSchema' before
 * initialization". Only surfaced once the service could boot far enough to
 * load this module (TS-501).
 */
const PathProviderIdSchema = z
  .string()
  .min(1)
  .max(PROVIDER_DISCOVERY_ID_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/, 'providerId must be alphanumeric / _ / -');

@Controller('api/v1/internal/providers')
@UseGuards(ProviderDiscoverySharedSecretGuard)
export class ProviderDiscoveryController {
  constructor(
    private readonly service: ProviderDiscoveryService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get(':providerId/discovery-snapshot')
  @HttpCode(HttpStatus.OK)
  async getSnapshot(
    @Param('providerId', new ZodValidationPipe(PathProviderIdSchema))
    providerId: string,
  ): Promise<ProviderDiscoverySnapshotResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-provider-discovery-snapshot',
      async () => this.service.getSnapshot(providerId),
    );
  }
}
