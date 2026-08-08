import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import {
  BookingServiceKindSchema,
  ServiceCatalogListResponseSchema,
  UpsertServiceCatalogEntryRequestSchema,
  UpsertServiceCatalogEntryResponseSchema,
  type BookingServiceKind,
  type ServiceCatalogListResponse,
  type UpsertServiceCatalogEntryRequest,
  type UpsertServiceCatalogEntryResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { SuperAdminRoleGuard } from '../../../common/guards/admin-role.guard';
import { CatalogService, type CatalogServiceFailure } from '../services/catalog.service';

/**
 * Service-catalog HTTP boundary (TS-060-followup-2; PRD §5.4 / §6.3,
 * PDD §8.2).
 *
 *   GET /api/v1/service-catalog
 *     Authenticated read of every catalog entry (active + inactive),
 *     ordered by `sortPosition`. Behind `AccessTokenGuard` — any
 *     authenticated actor may read the catalog (it is reference pricing
 *     metadata, not tenant data). Consumed by the family-portal picker
 *     (via the future gateway read proxy — TS-060-followup-2b) and the
 *     admin editor (TS-128-followup-6).
 *
 *   PUT /api/v1/admin/service-catalog/:kind
 *     Super-admin upsert of one catalog row, keyed on `:kind`. Behind
 *     `AccessTokenGuard` + `SuperAdminRoleGuard`. The body is a
 *     full-replace of the editable columns; `:kind` is the path param.
 *     `@Idempotent()` collapses a retried write against the cached
 *     result (CLAUDE.md §3.3).
 *
 * **Out of scope here** (named owners): the gateway BFF proxy +
 * web-admin editor UI (TS-128-followup-6 / TS-060-followup-2b); the
 * booking-create flow consulting the catalog for `basePrice`
 * (TS-060-followup-2a); audit-event emission on the admin write
 * (joins TS-128-followup-7); OTel + Prometheus (TS-060-followup-2d).
 *
 * **Money** is integer USD minor units on the wire; `CatalogService`
 * crosses to the `Decimal(12,2)` column via `src/common/money.ts`.
 */
@Controller()
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('api/v1/service-catalog')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async list(): Promise<ServiceCatalogListResponse> {
    const entries = await this.catalog.list();
    return ServiceCatalogListResponseSchema.parse({ entries });
  }

  @Put('api/v1/admin/service-catalog/:kind')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, SuperAdminRoleGuard)
  @Idempotent()
  async upsert(
    @Param('kind') kindParam: string,
    @Body(new ZodValidationPipe(UpsertServiceCatalogEntryRequestSchema))
    body: UpsertServiceCatalogEntryRequest,
  ): Promise<UpsertServiceCatalogEntryResponse> {
    const kind = parseKind(kindParam);
    const result = await this.catalog.upsert(kind, body);
    if (!result.ok) {
      throwFailure(result.error);
    }
    return UpsertServiceCatalogEntryResponseSchema.parse({ entry: result.value });
  }
}

/**
 * Narrow the `:kind` path param to a `BookingServiceKind`. An
 * unrecognised value is a malformed request (the catalog only knows the
 * seven enum kinds) → 400, mirroring the `ZodValidationPipe` shape.
 */
function parseKind(value: string): BookingServiceKind {
  const parsed = BookingServiceKindSchema.safeParse(value);
  if (!parsed.success) {
    throw new BadRequestException({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      detail: `Unknown service kind '${value}'.`,
    });
  }
  return parsed.data;
}

function throwFailure(failure: CatalogServiceFailure): never {
  switch (failure.reason) {
    case 'unsupported_currency':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Currency '${failure.currency}' is not supported. Phase 1 is USD-only.`,
      });
    case 'invalid_band':
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: 'baseRateMinMinor must be ≤ baseRateMaxMinor.',
      });
  }
}
