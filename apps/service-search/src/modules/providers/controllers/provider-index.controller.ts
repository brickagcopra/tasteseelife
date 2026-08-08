import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  PROVIDER_DISCOVERY_ID_MAX_LENGTH,
  UpsertProviderDocumentRequestSchema,
  type DeleteProviderDocumentResponse,
  type UpsertProviderDocumentRequest,
  type UpsertProviderDocumentResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { z } from 'zod';

import { InternalSharedSecretGuard } from '../../../common/guards/internal-shared-secret.guard';
import { ProviderSearchService } from '../services/provider-search.service';

const PathProviderIdSchema = z
  .string()
  .min(1)
  .max(PROVIDER_DISCOVERY_ID_MAX_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/, 'providerId must be alphanumeric / _ / -');

/**
 * Internal provider-index management surface (TS-111). The TS-053
 * search-indexer worker calls these endpoints to keep the
 * provider-discovery index in sync with the source-of-truth provider
 * row + companion materialisations:
 *
 *   `PUT /api/v1/internal/search/providers/:providerId`    — upsert
 *   `DELETE /api/v1/internal/search/providers/:providerId` — hard delete
 *
 * Both routes are pinned by `InternalSharedSecretGuard` (a shared
 * `SEARCH_INDEX_API_KEY` header). NetworkPolicy (TS-151) will further
 * restrict the route to in-cluster callers.
 *
 * **Tenant-scoping (TS-020-followup-2b-platform-rollout).** The
 * `InternalSharedSecretGuard` does NOT seed a `request.requestContext`
 * — the TS-053 search-indexer worker is a cluster-internal caller that
 * does not log in as a Taste & See user. The `TenantContextInterceptor`
 * therefore cannot seed a scoped frame, and the gate would fire
 * `MissingRequestContextError` on the first model touch — if service-search
 * had any Prisma touch. Today the service has no Prisma (PDD §7.2
 * search-svc primary store = Elasticsearch alone), so the gate has no
 * callsite. The handler bodies still wrap in
 * `runWithoutTenantContext(..., 'internal-search-provider-{upsert,delete}', ...)`
 * for defence-in-depth + parity with the canonical eleven-service
 * rollout shape: a future maintainer adding a Prisma read-side cache
 * table (TS-215 saved searches or similar) would otherwise hit a hard
 * `MissingRequestContextError` here. Mirrors the wrap landed in
 * service-media's `ScanEventsController.record`
 * (`internal-media-scan-event-record`) and service-activity's
 * `ActivityController.recordEvent` (`internal-activity-event-record`).
 */
@Controller('api/v1/internal/search/providers')
@UseGuards(InternalSharedSecretGuard)
export class ProviderIndexController {
  constructor(
    private readonly service: ProviderSearchService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Put(':providerId')
  @HttpCode(HttpStatus.OK)
  async upsert(
    @Param('providerId', new ZodValidationPipe(PathProviderIdSchema)) providerId: string,
    @Body(new ZodValidationPipe(UpsertProviderDocumentRequestSchema))
    body: UpsertProviderDocumentRequest,
  ): Promise<UpsertProviderDocumentResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-provider-upsert',
      async () => {
        const result = await this.service.upsertProvider({
          providerIdPath: providerId,
          document: body.document,
        });
        if (result.kind === 'failure') {
          throw new UnprocessableEntityException({
            type: 'about:blank',
            title: 'Unprocessable Entity',
            status: HttpStatus.UNPROCESSABLE_ENTITY,
            detail: result.detail,
            code: result.failure,
          });
        }
        return result.response;
      },
    );
  }

  @Delete(':providerId')
  @HttpCode(HttpStatus.OK)
  async delete(
    @Param('providerId', new ZodValidationPipe(PathProviderIdSchema)) providerId: string,
  ): Promise<DeleteProviderDocumentResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-search-provider-delete',
      async () => {
        return this.service.deleteProvider({ providerId });
      },
    );
  }
}
