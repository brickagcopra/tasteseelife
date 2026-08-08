import { timingSafeEqual } from 'node:crypto';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UsePipes,
} from '@nestjs/common';
import type {
  InternalHouseholdBillingContactsRequest,
  InternalHouseholdBillingContactsResponse,
  InternalHouseholdMembershipsResponse,
} from '@taste-and-see/contracts';
import {
  InternalHouseholdBillingContactsRequestSchema,
  InternalHouseholdBillingContactsResponseSchema,
  InternalHouseholdMembershipsResponseSchema,
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
import { HouseholdMembershipsService } from '../services/household-memberships.service';

/**
 * Internal household-membership surface (TS-505d2-followup-5). One
 * endpoint:
 *
 *   GET /api/v1/internal/users/:userId/household-memberships
 *     Returns every household the user actively belongs to. Sole consumer
 *     is api-gateway's household-scope resolver, which turns the answer
 *     into the request's `tenantScope` before signing the trust envelope.
 *
 * **Why this exists at all.** No access token the platform has ever issued
 * carried anything but `tenantScope: {type:'global'}`, while thirteen
 * downstream handlers resolve the acting household from that scope and
 * deliberately refuse a body-supplied id. Everything family-facing that
 * depends on it — the family dashboard, wellness trends and anomalies,
 * concierge tickets / onboarding / enrichment / emergency / assignments,
 * and "report a concern" — was unreachable. This route is the missing
 * satisfier, not a relaxation of the gate.
 *
 * **Auth model.** Shared-secret header, configurable via
 * `HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME` /
 * `HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY`. Identical defence-in-depth
 * pattern to `VisitPrepInternalController` (TS-208) and the wellness-
 * summary households route (TS-235); NetworkPolicy (TS-151) restricts the
 * route to in-cluster callers.
 *
 * **An unknown user is a 200 with an empty list, not a 404.** The question
 * is "which households may this user act in", and "none" answers it
 * completely. A 404 would also be indistinguishable from a renamed route
 * at the caller, which is precisely the confusion that lets a wiring
 * defect survive a deploy.
 *
 * **Tenant-scoping.** Runs before any `requestContext` exists, so the
 * handler body is wrapped in `runWithoutTenantContext` — the exempt frame
 * the Prisma extension's `enforce` posture requires. Correct here: this
 * surface's whole job is to answer a cross-household question, and the
 * caller has not yet been scoped because THIS is what scopes it.
 *
 * **Idempotency.** GET-only, naturally idempotent — no `@Idempotent()`.
 */
@Controller()
export class HouseholdMembershipsInternalController {
  private readonly internalApiKey: string;
  private readonly headerName: string;

  constructor(
    private readonly memberships: HouseholdMembershipsService,
    @Inject(ENV_TOKEN) env: Env,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {
    this.internalApiKey = env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY;
    this.headerName = env.HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME;
  }

  @Get('api/v1/internal/users/:userId/household-memberships')
  @HttpCode(HttpStatus.OK)
  async listForUser(
    @Param('userId') userId: string,
    @Req() request: Request,
  ): Promise<InternalHouseholdMembershipsResponse> {
    return runWithoutTenantContext(this.tenantStore, 'internal-household-memberships', async () => {
      this.requireSharedSecret(request);
      const result = await this.memberships.listForUser({ userId });
      // Parse at the boundary so a widened `select` or a cap breach
      // surfaces here rather than as a 502 at the gateway — and the
      // gateway is making an AUTHORISATION decision with this value.
      return InternalHouseholdMembershipsResponseSchema.parse(result);
    });
  }

  /**
   * POST /api/v1/internal/households/billing-contacts (TS-042-followup-3a1).
   *
   * Resolves a batch of household ids to the user ids of their active
   * `primary_payer` members — the missing first hop of every family-facing
   * billing notification. The caller chains into service-identity's
   * `recipient-contacts` route for the address.
   *
   * POST rather than GET because the input is a batch in a body; the same
   * shape as identity's recipient-contacts batch, which it feeds. Still a
   * pure read, so no `@Idempotent()`.
   *
   * Status codes:
   *   200 OK            — `{ contacts }`, possibly shorter than the request
   *                       (a household with no active payer is absent).
   *   400 Bad Request   — Zod validation (batch empty, over cap, unknown field).
   *   401 Unauthorized  — missing or wrong shared-secret header.
   */
  @Post('api/v1/internal/households/billing-contacts')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(InternalHouseholdBillingContactsRequestSchema))
  async resolveBillingContacts(
    @Body() body: InternalHouseholdBillingContactsRequest,
    @Req() request: Request,
  ): Promise<InternalHouseholdBillingContactsResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-household-billing-contacts',
      async () => {
        this.requireSharedSecret(request);
        const result = await this.memberships.resolveBillingContacts({
          householdIds: body.householdIds,
        });
        // Parse at the boundary. Here it is a DISCLOSURE control as much as
        // a drift check: `.strict()` plus the payers-only projection is what
        // guarantees an observer's or a senior's user id cannot leave on
        // this route even if the query above were later widened.
        return InternalHouseholdBillingContactsResponseSchema.parse(result);
      },
    );
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
 * Constant-time shared-secret comparison. Same shape as
 * `VisitPrepInternalController` — length check as the early reject,
 * `timingSafeEqual` over equal-length buffers as the authoritative
 * compare.
 */
function isSharedSecretValid(presented: string | undefined, expected: string): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
