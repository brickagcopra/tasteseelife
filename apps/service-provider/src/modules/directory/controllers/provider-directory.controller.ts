import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ListProvidersQuerySchema,
  ProviderDirectoryListResponseSchema,
  type ProviderDirectoryListResponse,
  type ProviderDirectoryRow,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';

import { ProviderDirectoryService } from '../services/provider-directory.service';

/**
 * Admin provider directory HTTP boundary (TS-305c-followup-1;
 * PRD §10.14, PDD §16.1).
 *
 *   GET /api/v1/admin/providers?q=&status=&tier=&includeArchived=&limit=&offset=
 *     The list an operator uses to FIND a provider.
 *
 * **Why this route had to exist.** The Provider 360 (TS-305c) is
 * entered from an incident that already names a provider. A committee
 * convened about someone by name had no way in at all, and a routine
 * tier review — a provider with no incident, which is the common case
 * — had none either. The service had no admin list of any kind: every
 * provider read was self-scoped, keyed on an id the caller already
 * held, or family-facing and active-only.
 *
 * **Gated on `provider:read`** — the same permission as the dossier
 * (TS-305a), and for the same reason: `provider:approve` is a WRITE
 * authority, and gating a directory on it would hand credential
 * revocation to everyone allowed to look at a list of names.
 * `provider:read` is held by `super_admin`, `operations_manager`,
 * `provider_ops`, and `trust_safety`. No new permission and therefore
 * **no `pnpm seed:rbac` re-run** for this task.
 *
 * **Read-only, no idempotency key.** GET is naturally idempotent.
 *
 * **No audit emission.** This mutates nothing, and read-audit on admin
 * surfaces is a platform-wide question (TS-128-followup-7) — solving it
 * on one list read would put this service out of step with the other
 * twenty. service-provider's write paths DO emit (TS-305a-followup-1).
 *
 * **Query parsing is explicit, not a `ValidationPipe`.** The query
 * arrives as `Record<string, string>` and the contract schema owns the
 * coercion (`limit`, `offset`, `includeArchived`) and the `.strict()`
 * rejection of unknown keys. A typo'd filter (`?statuss=active`) must
 * 400, never silently return an unfiltered directory — an operator who
 * believes they filtered to suspended providers and is shown all of
 * them will draw the wrong conclusion from the page.
 *
 * **Tenant scoping.** The route is authenticated, so
 * `TenantContextInterceptor` has seeded a scoped frame before the
 * handler runs — no `runWithoutTenantContext` wrap.
 */
@Controller()
export class ProviderDirectoryController {
  constructor(private readonly directory: ProviderDirectoryService) {}

  @Get('api/v1/admin/providers')
  @HttpCode(HttpStatus.OK)
  @UseGuards(AccessTokenGuard, PermissionGuard)
  @RequirePermissions('provider:read')
  async listProviders(
    @Query() rawQuery: Record<string, unknown>,
  ): Promise<ProviderDirectoryListResponse> {
    const parsed = ListProvidersQuerySchema.safeParse(rawQuery);
    if (!parsed.success) {
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: HttpStatus.BAD_REQUEST,
        detail: 'Provider directory query failed validation.',
        issues: parsed.error.issues,
      });
    }

    const page = await this.directory.list(parsed.data);

    const response: ProviderDirectoryListResponse = {
      providers: page.rows.map(toDirectoryRowDto),
      total: page.total,
      // Echoed as APPLIED, from the parsed value rather than the raw
      // query — a caller that sent no `limit` sees the default, and a
      // caller whose `limit` was defaulted cannot mistake the page size
      // for one it chose.
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    };
    return ProviderDirectoryListResponseSchema.parse(response);
  }
}

/**
 * Project a directory row to the wire DTO.
 *
 * Separate from the dossier's `toDossierCoreDto` and from the public
 * profile's `toProfileDto`: three mappers for three audiences. This
 * one deliberately carries neither `bio` nor the media keys — see the
 * contract's row doc-block. Merging any two of these is how an admin
 * field ends up on a family-facing response.
 */
function toDirectoryRowDto(row: {
  readonly id: string;
  readonly userId: string;
  readonly status: ProviderDirectoryRow['status'];
  readonly tier: ProviderDirectoryRow['tier'];
  readonly displayName: string;
  readonly headline: string | null;
  readonly timeZone: string;
  readonly dementiaSensitive: boolean;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}): ProviderDirectoryRow {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    tier: row.tier,
    displayName: row.displayName,
    headline: row.headline,
    timeZone: row.timeZone,
    dementiaSensitive: row.dementiaSensitive,
    createdAt: row.createdAt.toISOString(),
    deletedAt: row.deletedAt !== null ? row.deletedAt.toISOString() : null,
  };
}
