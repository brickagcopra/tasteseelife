import { AuditEventsListResponseSchema, type AuditEventResponse } from '@taste-and-see/contracts';

import { gateway, type GatewayResponse } from './gateway-client';

/**
 * Reading the audit trail through the surface an auditor uses (TS-505d2-followup-3).
 *
 * Same posture as `accounting-flows.ts`: every read goes through
 * `GET /api/v1/admin/audit/events/*` rather than the harness's database
 * connection. An audit trail that is correct in Postgres and unreachable
 * through the admin surface has not evidenced anything.
 *
 * All of these require `audit:read`, which `super_admin` holds.
 */

/**
 * Poll the per-resource trail until it holds at least `expected` events.
 *
 * The wait covers two asynchronous hops — `worker-outbox-relay` polling
 * `identity.outbox_events` and publishing to a Redis Stream, then
 * service-audit's consumer reading it — and is stated as a budget rather
 * than a retry count, for the same reason the money path's is.
 *
 * Waiting for a COUNT rather than for "any event" matters here: the chain
 * assertion needs both events, and a trail that has landed only the first is
 * a state the suite would otherwise read as a broken chain.
 */
export async function waitForAuditEvents(
  accessToken: string,
  resourceKind: string,
  resourceId: string,
  expected: number,
  options: { readonly timeoutMs?: number } = {},
): Promise<AuditEventResponse[]> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const deadline = Date.now() + timeoutMs;
  let seen = 0;

  for (;;) {
    const events = await listAuditEventsByResource(accessToken, resourceKind, resourceId);
    seen = events.length;
    if (seen >= expected) {
      return events;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Expected ${String(expected)} audit events for ${resourceKind}/${resourceId} ` +
          `within ${String(timeoutMs)}ms; saw ${String(seen)}. Either identity did not ` +
          `emit, the relay did not publish, or service-audit did not consume. Check ` +
          `test-results/fleet/{service-identity,worker-outbox-relay,service-audit}.log.`,
      );
    }
    await delay(500);
  }
}

/** `GET /api/v1/admin/audit/events/by-resource` — one resource's whole trail. */
export async function listAuditEventsByResource(
  accessToken: string,
  resourceKind: string,
  resourceId: string,
): Promise<AuditEventResponse[]> {
  const query = new URLSearchParams({ resourceKind, resourceId, limit: '50' });
  const response = await gateway(`/api/v1/admin/audit/events/by-resource?${query.toString()}`, {
    accessToken,
  });
  expectStatus(response, 200, 'admin/audit/events/by-resource');
  return [...AuditEventsListResponseSchema.parse(response.body).events];
}

/** `GET /api/v1/admin/audit/events/by-actor` — everything one actor did. */
export async function listAuditEventsByActor(
  accessToken: string,
  actorUserId: string,
): Promise<AuditEventResponse[]> {
  const query = new URLSearchParams({ actorUserId, limit: '50' });
  const response = await gateway(`/api/v1/admin/audit/events/by-actor?${query.toString()}`, {
    accessToken,
  });
  expectStatus(response, 200, 'admin/audit/events/by-actor');
  return [...AuditEventsListResponseSchema.parse(response.body).events];
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));
}

function expectStatus(response: GatewayResponse, expected: number, surface: string): void {
  if (response.status !== expected) {
    throw new Error(
      `${surface} returned ${String(response.status)}, expected ${String(expected)}: ${response.text.slice(0, 800)}`,
    );
  }
}
