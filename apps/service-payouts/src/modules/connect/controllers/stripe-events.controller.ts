import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import {
  type IngestStripeAccountEventRequest,
  IngestStripeAccountEventRequestSchema,
  type IngestStripeAccountEventResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

import { toIngestStripeAccountEventResponse } from '../mappers/payout-account.mapper';
import { StripeAccountEventsService } from '../services/stripe-account-events.service';

/**
 * Internal `account.updated` ingest endpoint (TS-090).
 *
 *   POST /api/v1/internal/payouts/stripe-account-events
 *     Shared-secret pinned via `STRIPE_EVENTS_HEADER_NAME` /
 *     `STRIPE_EVENTS_API_KEY` (constant-time `timingSafeEqual`).
 *
 * service-webhook (TS-041a) verifies the Stripe webhook signature,
 * persists the raw event in `stripe_processed_events`, and forwards a
 * down-projected payload here. service-payouts owns the application-
 * side state mutation; service-webhook owns signature verification.
 *
 * Failure mapping:
 *   401 — missing / wrong shared-secret header.
 *   400 — Zod validation failure.
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). This endpoint
 * authenticates via the `STRIPE_EVENTS_HEADER_NAME` shared secret
 * rather than the `AccessTokenGuard`, so the `TenantContextInterceptor`
 * cannot seed a scoped frame from a `request.requestContext` that does
 * not exist. The handler body wraps in `runWithoutTenantContext(...,
 * 'internal-stripe-account-event', ...)` so every Prisma operation
 * downstream (the stripe-event upsert + the provider-payout-account
 * mutation in a single transaction) sees an explicit `exempt` frame
 * rather than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`.
 */
@Controller()
export class StripeEventsController {
  private readonly internalApiKey: string;
  private readonly internalHeaderName: string;

  constructor(
    private readonly events: StripeAccountEventsService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN)
    private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.STRIPE_EVENTS_API_KEY;
    this.internalHeaderName = env.STRIPE_EVENTS_HEADER_NAME;
  }

  @Post('api/v1/internal/payouts/stripe-account-events')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(IngestStripeAccountEventRequestSchema))
  async ingest(
    @Body() body: IngestStripeAccountEventRequest,
    @Req() request: Request,
  ): Promise<IngestStripeAccountEventResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-stripe-account-event', async () => {
      const presented = request.header(this.internalHeaderName);
      if (!isSharedSecretValid(presented, this.internalApiKey)) {
        throw new UnauthorizedException({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'Internal stripe-events authentication failed.',
        });
      }

      const result = await this.events.ingest({
        stripeEventId: body.stripeEventId,
        eventType: body.eventType,
        stripeAccountId: body.stripeAccountId,
        occurredAt: new Date(body.occurredAt),
        payload: body.payload,
      });

      return toIngestStripeAccountEventResponse(result.outcome, result.account);
    });
  }
}

function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
