import { Controller, Get, HttpCode, HttpStatus, Inject, Logger } from '@nestjs/common';
import type { PlansListResponse } from '@taste-and-see/contracts';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { PlansService } from '../services/plans.service';

/**
 * Public plan-catalog endpoint.
 *
 * `GET /api/v1/plans` returns every active plan ordered for the public
 * pricing page. The endpoint is **anonymous** by design — the catalog is
 * marketing material that the marketing site (TS-120) and the family
 * portal (TS-121) both render to unauthenticated visitors. There is no
 * meaningful PII or business secret leaked: the catalog is the same
 * everyone sees on the pricing page.
 *
 * Future surfaces (TS-127 admin tooling) sit behind the
 * `AccessTokenGuard` + `@RequirePermissions('subscription:write')` that
 * lands once the guard package is wired into this service.
 *
 * No `Idempotency-Key` plumbing here because the endpoint is read-only
 * (CLAUDE.md §3.3 idempotency applies to write endpoints).
 *
 * Tenant-scoping (TS-020-followup-2b-platform-rollout). The handler runs
 * BEFORE any `requestContext` exists — the endpoint is anonymous, so
 * the `TenantContextInterceptor` cannot seed a scoped frame. The body
 * is wrapped in `runWithoutTenantContext(..., 'pre-auth-plans-list', ...)`
 * so the Prisma extension's gate sees an explicit `exempt` frame rather
 * than failing with `MissingRequestContextError` under the
 * `enforcement: 'enforce'` posture wired in `AppModule`. The `Plan`
 * model is also marked `unscoped` in `TenantContextModule.forRoot`'s
 * `unscopedModels` list (it's a platform-wide catalog), so the gate
 * would short-circuit before consulting the frame — the wrap is the
 * belt-and-braces defense in case a future read here touches a scoped
 * model (e.g. joining against an enrolment count). Same reasoning as
 * the AuthController wraps landed under TS-020-followup-2a.
 */
@Controller({ path: 'api/v1/plans' })
export class PlansController {
  private readonly logger = new Logger(PlansController.name);

  constructor(
    private readonly plans: PlansService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list(): Promise<PlansListResponse> {
    return runWithoutTenantContext(this.tenantStore, 'pre-auth-plans-list', async () => {
      const plans = await this.plans.listActive();
      this.logger.log({ count: plans.length }, 'GET /api/v1/plans');
      return { plans: [...plans] };
    });
  }
}
