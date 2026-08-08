import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ConciergeRideStatusWebhookEventSchema,
  ConciergeRideStatusWebhookResponseSchema,
  type ConciergeRideStatusWebhookEvent,
  type ConciergeRideStatusWebhookResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  runWithoutTenantContext,
  type TenantContextStore,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { TransportationSharedSecretGuard } from '../../../common/guards/transportation-shared-secret.guard';
import { TransportationService } from '../services/transportation.service';

/**
 * Inbound ride-status webhook endpoint (TS-226).
 *
 * `POST /internal/concierge/transportation/ride-events` is the single URL a
 * ride-hailing vendor (Uber Health / Lyft Health, Phase 3) POSTs to as a ride
 * progresses. The service matches the event to a stored request by
 * (`externalProvider`, `externalReference`), maps the raw vendor status onto
 * the domain lifecycle via the per-vendor adapter, and mirrors it back.
 *
 * **Auth.** The endpoint is pinned by `TransportationSharedSecretGuard` — a
 * constant-time shared-secret header (webhook auth IS the model — no
 * ride-hailing edge logs in as a Taste & See user, CLAUDE.md §3.5 / §17.8). It
 * is NOT exposed at the gateway. The guard fails closed: when the secret is
 * unset (the Phase-1 default, since every ride runs on the `manual` provider),
 * EVERY request is rejected.
 *
 * **`manual` is rejected.** A manually-coordinated ride has no vendor edge, so
 * an event claiming `externalProvider: 'manual'` is a 400 — the concierge
 * drives a manual ride's lifecycle via the PATCH surface, not a webhook.
 *
 * **Tenant-scoping (TS-020-followup-2b / §3.2).** This endpoint runs BEFORE any
 * `requestContext` exists — the vendor edge does not log in, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. The handler body is
 * wrapped in `runWithoutTenantContext(..., 'internal-transportation-ride-event',
 * ...)` so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the `enforce` posture
 * wired in `AppModule`. The wrap encloses the `manual` rejection + the
 * `applyWebhookEvent` call so a future maintainer cannot accidentally hoist a
 * Prisma call out of the wrap. Mirrors the canonical shape landed in
 * service-webhook's `StripeWebhookController` + service-identity's
 * `KycController.receiveWebhookEvent`.
 */
@Controller()
export class TransportationWebhookController {
  constructor(
    private readonly transportation: TransportationService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Post('internal/concierge/transportation/ride-events')
  @HttpCode(HttpStatus.OK)
  @UseGuards(TransportationSharedSecretGuard)
  async receive(
    @Body(new ZodValidationPipe(ConciergeRideStatusWebhookEventSchema))
    body: ConciergeRideStatusWebhookEvent,
  ): Promise<ConciergeRideStatusWebhookResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-transportation-ride-event',
      async () => {
        if (body.externalProvider === 'manual') {
          throw new BadRequestException({
            type: 'about:blank',
            title: 'Bad Request',
            status: HttpStatus.BAD_REQUEST,
            detail:
              'A manually-coordinated ride has no vendor edge; manual ride-status events are not accepted.',
          });
        }

        const result = await this.transportation.applyWebhookEvent({
          externalProvider: body.externalProvider,
          externalReference: body.externalReference,
          externalStatus: body.externalStatus,
          occurredAt: body.occurredAt,
        });

        const response: ConciergeRideStatusWebhookResponse = {
          received: true,
          outcome: result.outcome,
          status: result.status,
        };
        return ConciergeRideStatusWebhookResponseSchema.parse(response);
      },
    );
  }
}
