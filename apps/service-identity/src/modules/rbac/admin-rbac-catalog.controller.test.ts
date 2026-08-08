import 'reflect-metadata';

import { RBAC_CATALOG_FORMAT_VERSION, type RbacCatalogEnvelope } from '@taste-and-see/contracts';
import { REQUIRE_PERMISSIONS_METADATA_KEY } from '@taste-and-see/nest-auth';
import { describe, expect, it, vi } from 'vitest';

import { AdminRbacCatalogController } from './admin-rbac-catalog.controller';
import type { RbacCatalogPortService } from './rbac-catalog-port.service';

const ENVELOPE: RbacCatalogEnvelope = {
  formatVersion: RBAC_CATALOG_FORMAT_VERSION,
  exportedAt: '2026-07-02T12:00:00.000Z',
  permissions: [{ resource: 'rbac', action: 'read', description: 'Read the RBAC catalog.' }],
  roles: [
    {
      name: 'read_only_auditor',
      description: 'Auditor.',
      isSystem: true,
      permissions: ['rbac:read'],
    },
  ],
};

function buildService(exportCatalog = vi.fn(async (_now: Date) => ENVELOPE)): {
  service: RbacCatalogPortService;
  exportCatalog: typeof exportCatalog;
} {
  return {
    service: { exportCatalog } as unknown as RbacCatalogPortService,
    exportCatalog,
  };
}

describe('AdminRbacCatalogController.exportCatalog', () => {
  it('returns the contract-validated envelope from the port service', async () => {
    const { service, exportCatalog } = buildService();
    const controller = new AdminRbacCatalogController(service);

    const result = await controller.exportCatalog();
    expect(result).toEqual(ENVELOPE);
    expect(exportCatalog).toHaveBeenCalledTimes(1);
    expect(exportCatalog.mock.calls[0]?.[0]).toBeInstanceOf(Date);
  });

  it('surfaces a contract drift as a parse error at the boundary', async () => {
    const { service } = buildService(
      vi.fn(
        async (_now: Date) =>
          ({ ...ENVELOPE, formatVersion: 99 }) as unknown as RbacCatalogEnvelope,
      ),
    );
    const controller = new AdminRbacCatalogController(service);
    await expect(controller.exportCatalog()).rejects.toThrowError();
  });

  it('gates on rbac:read (and export is the ONLY route — no import endpoint)', () => {
    const handler = AdminRbacCatalogController.prototype.exportCatalog;
    const permissions = Reflect.getMetadata(REQUIRE_PERMISSIONS_METADATA_KEY, handler) as unknown;
    expect(permissions).toEqual(['rbac:read']);

    const routeMethods = Object.getOwnPropertyNames(AdminRbacCatalogController.prototype).filter(
      (name) => name !== 'constructor',
    );
    expect(routeMethods).toEqual(['exportCatalog']);
  });
});
