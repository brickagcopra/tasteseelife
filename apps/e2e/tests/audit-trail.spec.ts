import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

import { registerAdminUser } from '../src/admin-flows';
import { listAuditEventsByActor, waitForAuditEvents } from '../src/audit-flows';
import { registerVerifiedUser } from '../src/auth-flows';
import { gateway, type GatewayResponse } from '../src/gateway-client';
import { idempotencyKey } from '../src/actors';

/**
 * The append-only audit trail, end to end (TS-505d2-followup-3; CLAUDE.md §3.6).
 *
 * **This control has been silently empty for the platform's whole life.** Five
 * services emit `audit.action_recorded` inside the same transaction as the
 * mutation it describes, `service-audit` has had a consumer handler for it
 * since it was built, and `worker-outbox-relay` has carried
 * `identity.outbox_events` all along. But the consumer never subscribed
 * (TS-505d2: the SDK's scheduler bootstrapped on the wrong Nest hook), so not
 * one audit event ever reached the audit service — while every unit suite on
 * both sides stayed green. §3.6 says "every admin mutation emits an audit
 * event"; it did emit, and nothing was listening.
 *
 * So this spec is not coverage for a feature. It is the first evidence that the
 * control works at all.
 *
 * **Why role mutations are the producer.** They are the shortest real path from
 * a gateway-reachable admin action to a durable audit row, and the RBAC surface
 * is exactly the one §3.2 says privilege escalation must be auditable on. Two
 * mutations on ONE role are used deliberately: the hash chain is scoped per
 * `(resourceKind, resourceId)`, so a single event cannot demonstrate it.
 */

/** `rbac_role` — `RBAC_AUDIT_RESOURCE.role` in service-identity. */
const ROLE_RESOURCE_KIND = 'rbac_role';

test.describe('audit trail', () => {
  test('an admin mutation lands in the audit trail with a verifiable hash chain', async () => {
    const admin = await registerAdminUser('audit-chain');
    const roleName = `e2e_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    const created = await post('/api/v1/admin/roles', admin.accessToken, {
      name: roleName,
      description: 'Created by the E2E audit-trail spec.',
      permissions: [],
    });
    expect(created.status, created.text).toBe(201);
    const roleId = (created.body as { role: { id: string } }).role.id;

    const archived = await post(`/api/v1/admin/roles/${roleId}/archive`, admin.accessToken, {
      note: 'Archived by the E2E audit-trail spec.',
    });
    expect(archived.status, archived.text).toBe(200);

    // identity emits in-transaction → relay → Redis Stream → service-audit.
    const events = await waitForAuditEvents(admin.accessToken, ROLE_RESOURCE_KIND, roleId, 2);

    // Both mutations are on the trail, attributed to the admin who made them.
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.actorUserId).toBe(admin.userId);
      expect(event.resourceId).toBe(roleId);
      expect(event.resourceKind).toBe(ROLE_RESOURCE_KIND);
    }

    // **The hash chain (§3.6).** Ordering is newest-first on the read surface,
    // so the chain runs backwards through the list: the older event's
    // `chainHash` must be exactly the newer one's `chainPrevHash`, and the
    // first event of a resource has no predecessor. This is the property that
    // makes the log tamper-evident, and nothing has ever executed it.
    const [newer, older] = events as [(typeof events)[0], (typeof events)[0]];
    expect(older.chainPrevHash).toBeNull();
    expect(newer.chainPrevHash).toBe(older.chainHash);
    expect(newer.chainHash).not.toBe(older.chainHash);
    expect(newer.chainHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('the trail is queryable by actor, and records who did it', async () => {
    const admin = await registerAdminUser('audit-actor');
    const roleName = `e2e_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

    const created = await post('/api/v1/admin/roles', admin.accessToken, {
      name: roleName,
      permissions: [],
    });
    expect(created.status, created.text).toBe(201);
    const roleId = (created.body as { role: { id: string } }).role.id;

    await waitForAuditEvents(admin.accessToken, ROLE_RESOURCE_KIND, roleId, 1);

    // "What did this operator do?" is the question an investigation starts
    // from, and it is a different index from the per-resource trail.
    const byActor = await listAuditEventsByActor(admin.accessToken, admin.userId);
    const mine = byActor.filter((event) => event.resourceId === roleId);

    expect(mine).toHaveLength(1);
    expect(mine[0]?.actorUserId).toBe(admin.userId);
    // A newly-minted staff account acts under global scope, not a tenant.
    expect(mine[0]?.actorTenantScopeType).toBe('global');
  });

  test('the audit trail is not readable without audit:read', async () => {
    const admin = await registerAdminUser('audit-gate');
    const customer = await registerVerifiedUser('audit-outsider');

    const roleName = `e2e_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const created = await post('/api/v1/admin/roles', admin.accessToken, {
      name: roleName,
      permissions: [],
    });
    const roleId = (created.body as { role: { id: string } }).role.id;

    const query = new URLSearchParams({
      resourceKind: ROLE_RESOURCE_KIND,
      resourceId: roleId,
    });
    const forbidden = await gateway(`/api/v1/admin/audit/events/by-resource?${query.toString()}`, {
      accessToken: customer.accessToken,
    });

    // An audit log readable by any authenticated caller is a disclosure
    // surface: it names actors, resources and IP addresses.
    expect(forbidden.status).toBe(403);

    const anonymous = await gateway(`/api/v1/admin/audit/events/by-resource?${query.toString()}`);
    expect(anonymous.status).toBe(401);
  });
});

/** POST through the gateway, always carrying an `Idempotency-Key` (§3.3). */
async function post(
  path: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<GatewayResponse> {
  return gateway(path, {
    method: 'POST',
    accessToken,
    idempotencyKey: idempotencyKey(),
    body,
  });
}
