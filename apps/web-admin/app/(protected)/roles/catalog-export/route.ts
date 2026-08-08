import {
  AdminRbacCatalogExportResponseSchema,
  MeResponseSchema,
  type MeResponse,
} from '@taste-and-see/contracts';

import { callGateway } from '@/lib/api';
import { hasPermission } from '@/lib/admin-gate';

/**
 * RBAC catalog JSON export download (TS-299; PRD §10.12; PDD §10.3).
 *
 *   GET /roles/catalog-export
 *
 * Streams the gateway's `GET /api/v1/admin/rbac-catalog/export`
 * envelope as an `application/json` attachment — the saved file feeds
 * straight into `rbac:catalog import` in another environment. Re-checks
 * `rbac:read` server-side (the route handler is its own trust boundary
 * — it doesn't rely on the page gate; mirrors the SaaS-metrics CSV
 * export) and forwards the portal access-token cookie via
 * `callGateway`, so the browser never reaches service-identity
 * directly. Import has no web surface at all — it is CLI-only.
 */
export async function GET(): Promise<Response> {
  const me = await fetchMe();
  if (me === null) {
    return forbidden('Authentication required.');
  }
  if (!me.mfaVerified || !hasPermission(me, 'rbac:read')) {
    return forbidden('rbac:read access required.');
  }

  const result = await callGateway<unknown>('/api/v1/admin/rbac-catalog/export');
  if (result.kind === 'unauthorized') {
    return forbidden('Authentication required.');
  }
  if (result.kind !== 'ok') {
    return new Response('Unable to load the RBAC catalog for export.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const parsed = AdminRbacCatalogExportResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return new Response('The RBAC catalog export did not match its contract.', {
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }

  const filename = `rbac-catalog_${parsed.data.exportedAt.slice(0, 10)}.json`;
  return new Response(`${JSON.stringify(parsed.data, null, 2)}\n`, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      'cache-control': 'no-store',
    },
  });
}

async function fetchMe(): Promise<MeResponse | null> {
  const result = await callGateway<unknown>('/api/v1/me');
  if (result.kind !== 'ok') return null;
  const parsed = MeResponseSchema.safeParse(result.body);
  return parsed.success ? parsed.data : null;
}

function forbidden(detail: string): Response {
  return new Response(detail, {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
