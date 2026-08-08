import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  InternalProviderBillingContactsRequestSchema,
  InternalProviderBillingContactsResponseSchema,
  type InternalProviderBillingContactsRequest,
  type InternalProviderBillingContactsResponse,
} from '@taste-and-see/contracts';
import { ZodValidationPipe } from '@taste-and-see/nest-common';
import {
  TENANT_CONTEXT_STORE_TOKEN,
  type TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { ProviderBillingContactsSharedSecretGuard } from '../../../common/guards/provider-billing-contacts-shared-secret.guard';
import { ProviderBillingContactsService } from '../services/provider-billing-contacts.service';

/**
 * `POST /api/v1/internal/providers/billing-contacts` (TS-042-followup-3a1a).
 *
 * Resolves a batch of provider ids to their owning account user ids — the
 * provider-group twin of service-household's
 * `POST /api/v1/internal/households/billing-contacts`, and the hop whose
 * absence meant a provider whose card failed was told nothing at all
 * (`skipped_customer_group` in the dunning ladder).
 *
 * POST rather than GET because the input is a batch in a body, matching the
 * household route it sits beside in the same call chain. Still a pure read,
 * so no `@Idempotent()`.
 *
 * **Shared-secret pinned, never gateway-routed** — this is a
 * service-to-service read of data no browser may see.
 *
 * **`runWithoutTenantContext`** because the caller authenticates with a
 * shared secret, so no `TenantContextInterceptor` frame exists and the
 * service's `enforce` posture would otherwise raise
 * `MissingRequestContextError`. The same wrap every internal route on this
 * platform carries.
 *
 * Status codes:
 *   200 OK           — `{ contacts }`, possibly shorter than the request
 *                      (an id matching no provider is absent).
 *   400 Bad Request  — Zod validation (batch empty, over cap, unknown field).
 *   401 Unauthorized — missing or wrong shared-secret header.
 */
@Controller()
@UseGuards(ProviderBillingContactsSharedSecretGuard)
export class ProviderBillingContactsController {
  constructor(
    private readonly service: ProviderBillingContactsService,
    @Inject(TENANT_CONTEXT_STORE_TOKEN) private readonly tenantStore: TenantContextStore,
  ) {}

  @Post('api/v1/internal/providers/billing-contacts')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(InternalProviderBillingContactsRequestSchema))
  async resolveBillingContacts(
    @Body() body: InternalProviderBillingContactsRequest,
  ): Promise<InternalProviderBillingContactsResponse> {
    return runWithoutTenantContext(
      this.tenantStore,
      'internal-provider-billing-contacts',
      async () => {
        const result = await this.service.resolveBillingContacts({
          providerIds: body.providerIds,
        });
        // Parse at the boundary. A disclosure control as much as a drift
        // check: `.strict()` is what guarantees a later widened `select`
        // cannot start returning a display name or an email on the one
        // route that must not, on its own, yield a mailable identity.
        return InternalProviderBillingContactsResponseSchema.parse(result);
      },
    );
  }
}
