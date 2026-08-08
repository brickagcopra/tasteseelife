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
  InternalRecipientContactsRequestSchema,
  InternalRecipientContactsResponseSchema,
  type InternalRecipientContactsRequest,
  type InternalRecipientContactsResponse,
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
import { RecipientContactsService } from '../services/recipient-contacts.service';

/**
 * Internal recipient-contacts batch surface (TS-235). One endpoint:
 *
 *   POST /api/v1/internal/identity/recipient-contacts
 *     Resolve a batch of user ids (1..500, capped at the Zod boundary)
 *     to their login email + account `status`. Sole consumer is the
 *     wellness-summary worker, which addresses senior-summary
 *     notifications to the resolved recipients and skips non-`active`
 *     accounts. A userId with no matching user row is simply ABSENT
 *     from the response `contacts` — the service does not synthesise a
 *     placeholder.
 *
 * **Auth model.** Pinned to a shared-secret header (configurable via
 * `IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME` /
 * `IDENTITY_RECIPIENT_CONTACTS_API_KEY`), NOT the `AccessTokenGuard`.
 * The header value IS the auth model for the route (CLAUDE.md §3.5 —
 * the Stripe-webhook pattern: signature/header is the auth). Mirrors
 * `KycController.receiveWebhookEvent` (TS-026) and
 * service-household's `VisitPrepInternalController` (TS-208).
 * Application-layer defence-in-depth alongside the TS-151
 * NetworkPolicy that further restricts the route to in-cluster
 * callers.
 *
 * **Input validation.** The body is validated with
 * `ZodValidationPipe(InternalRecipientContactsRequestSchema)` at the
 * controller boundary — unknown fields rejected (`.strict()`), the
 * batch size capped, the ids shape-checked. Malformed bodies surface
 * as a 400 before the handler body runs.
 *
 * **Response shape.** Parsed against
 * `InternalRecipientContactsResponseSchema` at the boundary
 * (defence-in-depth) so any future drift between the service
 * projection + the published contract surfaces here rather than at the
 * worker.
 *
 * **Idempotency.** Naturally idempotent — a pure read. No
 * `@Idempotent()` decorator (it would burn a Redis round-trip for no
 * behavioural gain).
 *
 * **Tenant-scoping (TS-020-followup-2b platform posture).** The
 * endpoint runs BEFORE any `requestContext` exists — it pins the
 * shared-secret header instead of `AccessTokenGuard`, so the
 * `TenantContextInterceptor` cannot seed a scoped frame. `User` is a
 * tenant-scoped model (NOT in the `AppModule` `unscopedModels` list),
 * so under the `enforce` posture an unwrapped `prisma.user.findMany`
 * would raise `MissingRequestContextError`. The handler body —
 * including the 401 short-circuit — is therefore wrapped in
 * `runWithoutTenantContext(this.tenantStore, 'internal-recipient-contacts', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame on
 * every code path. The exempt frame is correct here: this is a
 * cross-tenant internal projector and the caller (the wellness-summary
 * worker) is in-cluster and shared-secret-pinned.
 */
@Controller()
export class RecipientContactsController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly recipientContacts: RecipientContactsService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.IDENTITY_RECIPIENT_CONTACTS_API_KEY;
    this.headerName = env.IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME;
  }

  /**
   * POST /api/v1/internal/identity/recipient-contacts.
   *
   * Status codes:
   *   200 OK            — body is the InternalRecipientContactsResponse
   *                       ({ contacts } — possibly empty / shorter than
   *                       the requested id list).
   *   400 Bad Request   — payload failed Zod validation (handled by the
   *                       ZodValidationPipe before the handler runs).
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/identity/recipient-contacts')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(InternalRecipientContactsRequestSchema))
  async resolveContacts(
    @Body() body: InternalRecipientContactsRequest,
    @Req() request: Request,
  ): Promise<InternalRecipientContactsResponse> {
    // Pre-auth surface (shared-secret header, NOT AccessTokenGuard) so
    // no `requestContext` was seeded by the TenantContextInterceptor.
    // Wrap the entire body — including the 401 short-circuit — so the
    // Prisma extension's gate sees an explicit `exempt` frame on every
    // code path (`User` is a tenant-scoped model under the `enforce`
    // posture). Mirrors KycController.receiveWebhookEvent (TS-026) and
    // VisitPrepInternalController.getSnapshot (TS-208).
    return runWithoutTenantContext(this.tenantStore, 'internal-recipient-contacts', async () => {
      this.requireSharedSecret(request);

      const contacts = await this.recipientContacts.resolveBatch(body.userIds);

      // Defence-in-depth — parse at the boundary so drift between the
      // service projection + the contract surfaces here rather than
      // at the worker.
      return InternalRecipientContactsResponseSchema.parse({ contacts });
    });
  }

  private requireSharedSecret(request: Request): void {
    const presented = request.header(this.headerName);
    if (!isSharedSecretValid(presented, this.internalApiKey)) {
      throw new UnauthorizedException({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Internal authentication required.',
      });
    }
  }
}

/**
 * Constant-time shared-secret comparison. Mirrors the shape used in
 * `KycController` (TS-026) and `VisitPrepInternalController` (TS-208) —
 * the length check is the early reject, `timingSafeEqual` over
 * equal-length buffers is the authoritative compare. Defence-in-depth
 * against timing oracles even though this surface is in-cluster only.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
