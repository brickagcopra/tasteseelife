import { Controller, Get, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import {
  AdminRbacCatalogExportResponseSchema,
  type AdminRbacCatalogExportResponse,
} from '@taste-and-see/contracts';
import { AccessTokenGuard, PermissionGuard, RequirePermissions } from '@taste-and-see/nest-auth';

import { RbacCatalogPortService } from './rbac-catalog-port.service';

/**
 * RBAC catalog export HTTP boundary (TS-299; PRD §10.12; PDD §10.3).
 *
 *   GET /api/v1/admin/rbac-catalog/export — the portable, id-free
 *   catalog envelope (rbac:read)
 *
 * The response body IS the importable file — an operator can save it
 * and feed it straight to `rbac:catalog import` in another
 * environment.
 *
 * **There is deliberately NO import endpoint.** Importing can rewrite
 * system-role permission sets (with the explicit allow flag) — a
 * bulk-mutation footgun beyond anything the `rbac:write` HTTP surface
 * permits (which refuses system roles outright). Import runs only via
 * the `rbac:catalog` CLI (`src/scripts/rbac-catalog.ts`) with direct
 * DB access — the same ops posture as `seed:rbac` (K8s Job / operator
 * shell), where the audit trail records the system actor.
 *
 * Read-only and naturally idempotent — no `@Idempotent()` needed. The
 * api-gateway proxy re-enforces `rbac:read` at the edge
 * (defence-in-depth).
 */
@Controller()
@UseGuards(AccessTokenGuard, PermissionGuard)
export class AdminRbacCatalogController {
  constructor(private readonly port: RbacCatalogPortService) {}

  @Get('api/v1/admin/rbac-catalog/export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('rbac:read')
  async exportCatalog(): Promise<AdminRbacCatalogExportResponse> {
    const envelope = await this.port.exportCatalog(new Date());
    // Parse-validate before returning so a drift between the service
    // shape and the contract surfaces at the boundary (repo idiom).
    return AdminRbacCatalogExportResponseSchema.parse(envelope);
  }
}
