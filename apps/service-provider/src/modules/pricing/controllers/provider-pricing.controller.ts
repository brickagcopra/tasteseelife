import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Put,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ProviderPricingRecordSchema,
  UpdateProviderPricingRequestSchema,
  UpdateProviderPricingResponseSchema,
  resolveProviderPricingBand,
  type ProviderPricingRecord,
  type UpdateProviderPricingRequest,
  type UpdateProviderPricingResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, type RequestWithContext } from '@taste-and-see/nest-auth';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import { Idempotent } from '@taste-and-see/nest-idempotency';

import { decimalStringToMinor } from '../../../common/money';

import {
  ProviderPricingService,
  type ProviderPricingFailure,
  type ProviderRow,
} from '../services/provider-pricing.service';

/**
 * Provider pricing HTTP boundary (TS-204).
 *
 * Endpoints:
 *
 *   GET /api/v1/providers/me/pricing-snapshot
 *     Returns the authenticated user's pricing in the
 *     `{ pricing: ProviderPricingRecord | null }` shape. Powers the
 *     web-provider editor's initial render; `{ pricing: null }` when
 *     the user has no provider row yet (pre-application).
 *
 *   GET /api/v1/providers/:providerId/pricing
 *     Returns the bare `ProviderPricingRecord` for the given provider
 *     id; 404 on missing or soft-deleted. The read the future
 *     booking-quote path consumes (TS-204-followup-1). Any
 *     authenticated caller may read — no row-level ownership gate
 *     (PRD §6.3 frames the rate as part of the family-portal browse).
 *
 *   PUT /api/v1/providers/:providerId/pricing
 *     Self-service pricing update. The caller must own the provider
 *     row. The rate must sit inside the platform band for the
 *     provider's tier — out-of-band rejects with 422. Phase-1 USD-only
 *     — any other currency rejects with 422. Admin override lands as
 *     TS-204-followup-3 once `PermissionGuard` lifts.
 *
 *     Status codes:
 *       200 OK                  — body is the UpdateProviderPricingResponse.
 *       400 Bad Request         — payload / If-Match failed validation.
 *       401 Unauthorized        — missing / invalid access token.
 *       403 Forbidden           — provider exists but actor doesn't own it.
 *       404 Not Found           — provider doesn't exist / soft-deleted.
 *       412 Precondition Failed — `If-Match` set but `updated_at` drifted.
 *       422 Unprocessable Entity — rate out of the tier band, or
 *                                 unsupported currency.
 *
 * Optimistic concurrency + idempotency mirror the profile surface
 * (TS-200 / TS-200-followup-5): `If-Match: "<updatedAt>"` gates the
 * write against concurrent edits, and `@Idempotent()` collapses a
 * retried request with the same `Idempotency-Key`.
 */
interface PricingSnapshotResponse {
  readonly pricing: ProviderPricingRecord | null;
}

@Controller()
export class ProviderPricingController {
  constructor(private readonly pricing: ProviderPricingService) {}

  @Get('api/v1/providers/me/pricing-snapshot')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getMySnapshot(@Req() request: RequestWithContext): Promise<PricingSnapshotResponse> {
    const actorUserId = requireActorUserId(request);
    const row = await this.pricing.getPricingByUserId(actorUserId);
    if (row === null) {
      return { pricing: null };
    }
    return { pricing: toPricingDto(row) };
  }

  @Get('api/v1/providers/:providerId/pricing')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard)
  async getById(
    @Param('providerId') providerId: string,
    @Req() request: RequestWithContext,
  ): Promise<ProviderPricingRecord> {
    requireActorUserId(request);
    const row = await this.pricing.getPricing(providerId);
    if (row === null || row.deletedAt !== null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    }
    return toPricingDto(row);
  }

  @Put('api/v1/providers/:providerId/pricing')
  @UseGuards(AccessTokenGuard)
  @Idempotent()
  async update(
    @Param('providerId') providerId: string,
    @Body(new ZodValidationPipe(UpdateProviderPricingRequestSchema))
    body: UpdateProviderPricingRequest,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Req() request: RequestWithContext,
  ): Promise<UpdateProviderPricingResponse> {
    const actorUserId = requireActorUserId(request);

    const ifMatch = parseIfMatchHeader(ifMatchHeader);
    if (ifMatch.kind === 'invalid') {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail:
          "If-Match must be the snapshot's ISO-8601 updatedAt value (optionally quoted) or `*`.",
      });
    }

    const result = await this.pricing.updatePricing({
      providerId,
      actorUserId,
      hourlyRateMinor: body.hourlyRateMinor,
      currency: body.currency,
      ...(ifMatch.kind === 'precondition' && { ifMatchUpdatedAt: ifMatch.value }),
    });
    if (!result.ok) {
      throwFailure(result.error);
    }

    const response: UpdateProviderPricingResponse = {
      pricing: toPricingDto(result.value),
    };
    return UpdateProviderPricingResponseSchema.parse(response);
  }
}

type ParsedIfMatch =
  | { readonly kind: 'absent' }
  | { readonly kind: 'wildcard' }
  | { readonly kind: 'precondition'; readonly value: Date }
  | { readonly kind: 'invalid' };

function parseIfMatchHeader(header: string | undefined): ParsedIfMatch {
  if (header === undefined) return { kind: 'absent' };
  const trimmed = header.trim();
  if (trimmed.length === 0) return { kind: 'absent' };
  if (trimmed === '*') return { kind: 'wildcard' };
  if (trimmed.startsWith('W/')) return { kind: 'invalid' };
  let raw = trimmed;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    raw = raw.slice(1, -1);
  }
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return { kind: 'invalid' };
  return { kind: 'precondition', value: new Date(ms) };
}

function requireActorUserId(request: RequestWithContext): string {
  const ctx = request.requestContext;
  if (ctx === undefined) {
    throw new UnauthorizedException({
      type: 'about:blank',
      title: 'Unauthorized',
      status: 401,
      detail: 'Authentication required.',
    });
  }
  return ctx.userId;
}

function throwFailure(failure: ProviderPricingFailure): never {
  switch (failure.reason) {
    case 'invalid_request':
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: failure.message,
      });
    case 'not_found':
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Provider not found.',
      });
    case 'forbidden':
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You may only edit your own provider pricing.',
      });
    case 'precondition_failed':
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Precondition Failed',
          status: 412,
          detail: 'Your pricing has been updated since you loaded it. Refresh and try again.',
          currentUpdatedAt: failure.currentUpdatedAt.toISOString(),
        },
        HttpStatus.PRECONDITION_FAILED,
      );
    case 'unsupported_currency':
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: `Currency '${failure.currency}' is not supported. Taste & See is USD-only today.`,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    case 'out_of_band':
      throw new HttpException(
        {
          type: 'about:blank',
          title: 'Unprocessable Entity',
          status: 422,
          detail: `Hourly rate must be between ${failure.minHourlyRateMinor} and ${failure.maxHourlyRateMinor} minor units for the ${failure.tier} tier.`,
          tier: failure.tier,
          minHourlyRateMinor: failure.minHourlyRateMinor,
          maxHourlyRateMinor: failure.maxHourlyRateMinor,
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    case 'outbox_validation_failed':
      throw new InternalServerErrorException({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'Pricing update failed at the event-emission stage. Please retry.',
      });
  }
}

function toPricingDto(row: ProviderRow): ProviderPricingRecord {
  const dto: ProviderPricingRecord = {
    providerId: row.id,
    status: row.status,
    tier: row.tier,
    hourlyRateMinor:
      row.hourlyRate !== null ? decimalStringToMinor(row.hourlyRate.toString()) : null,
    currency: row.hourlyRateCurrency,
    band: resolveProviderPricingBand(row.tier),
    updatedAt: row.updatedAt.toISOString(),
  };
  // Parse-validate at projection time so a Prisma row shape drift
  // surfaces as a 500 (with stack trace) rather than as a silent
  // contract mismatch on the consumer side.
  return ProviderPricingRecordSchema.parse(dto);
}
