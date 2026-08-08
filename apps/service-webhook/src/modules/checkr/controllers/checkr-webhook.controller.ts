import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';

import { WebhookMetrics } from '../../../observability/webhook-metrics';
import { CHECKR_SIGNATURE_HEADER, CHECKR_WEBHOOK_PATH } from '../checkr.constants';
import { CheckrIngressService } from '../services/checkr-ingress.service';
import { CheckrWebhookVerifierService } from '../services/checkr-webhook-verifier.service';

interface CheckrWebhookAckResponse {
  readonly received: true;
  readonly eventId: string;
  readonly outcome: 'persisted' | 'duplicate';
}

/**
 * Inbound Checkr webhook endpoint (TS-051).
 *
 * `POST /api/v1/webhooks/checkr` is the single URL Checkr POSTs to
 * for every event the configured webhook endpoint subscribes to.
 * Same orchestration shape as `StripeWebhookController`:
 *
 *   1. Extract the verified raw body (express.raw scoped to this
 *      path in main.ts).
 *   2. Extract `X-Checkr-Signature`.
 *   3. Hand both to `CheckrWebhookVerifierService.verify`.
 *      - Failure → 400 (terse body; verifier service logs the
 *        precise reason server-side).
 *      - Success → step 4.
 *   4. Hand the verified event to `CheckrIngressService.persist`.
 *
 * Anonymous by design: signature verification IS the auth model
 * (CLAUDE.md §3.5 / §17.8).
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). Same shape as
 * `StripeWebhookController`: Checkr's edge does not log in as a Taste &
 * See user, so the `TenantContextInterceptor` cannot seed a scoped frame.
 * The handler body is wrapped in `runWithoutTenantContext(...,
 * 'external-checkr-webhook-receive', ...)` so the Prisma extension's
 * gate sees an explicit `exempt` frame on every Prisma read/write the
 * handler triggers. The wrap encloses the raw-body assertion + the 400
 * throw + the signature verification + the 400 throw + the
 * `ingress.persist` call so a future maintainer cannot accidentally
 * hoist a Prisma call out of the wrap.
 */
@Controller()
export class CheckrWebhookController {
  private readonly logger = new Logger(CheckrWebhookController.name);

  constructor(
    private readonly verifier: CheckrWebhookVerifierService,
    private readonly ingress: CheckrIngressService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
    // Optional default (TS-041a-followup-4) — same rationale as
    // StripeWebhookController: Nest injects the @Global singleton in
    // production; the default keeps three-arg manual construction in the
    // existing unit tests working.
    private readonly metrics: WebhookMetrics = new WebhookMetrics(),
  ) {}

  @Post(CHECKR_WEBHOOK_PATH)
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: Request,
    @Headers(CHECKR_SIGNATURE_HEADER) signatureHeader: string | string[] | undefined,
  ): Promise<CheckrWebhookAckResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'external-checkr-webhook-receive',
      async () => {
        const rawBody = request.body;
        if (!Buffer.isBuffer(rawBody)) {
          this.logger.error(
            { contentType: request.headers['content-type'] },
            'checkr webhook received without raw body — main.ts wiring is broken',
          );
          this.metrics.recordCheckrVerification('reject', 'missing_raw_body');
          throw new BadRequestException(badSignatureBody());
        }

        const verification = this.verifier.verify({ rawBody, signatureHeader });
        if (!verification.ok) {
          this.metrics.recordCheckrVerification('reject', verification.reason);
          throw new BadRequestException(badSignatureBody());
        }
        this.metrics.recordCheckrVerification('ok', 'none');

        const outcome = await this.ingress.persist({
          event: verification.event,
          payload: verification.payload,
          verifiedAt: verification.verifiedAt,
        });
        this.metrics.recordCheckrPersisted(outcome);

        return {
          received: true,
          eventId: verification.event.id,
          outcome,
        };
      },
    );
  }
}

function badSignatureBody(): {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
} {
  return {
    type: 'about:blank',
    title: 'Bad Request',
    status: 400,
    detail: 'Checkr webhook signature verification failed.',
  };
}
