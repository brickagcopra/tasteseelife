import { UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import {
  AuditService,
  type AuditEvent,
  type ListResult,
  type RecordEventInput,
  type RecordEventResult,
  type ListByResourceQuery,
  type ListByActorQuery,
} from '../services/audit.service';

import { AuditController } from './audit.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3016,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'taste-and-see/service-identity',
    JWT_AUDIENCE: 'taste-and-see/api',
    AUDIT_INGEST_HEADER_NAME: 'x-internal-api-key',
    AUDIT_INGEST_API_KEY: 'k'.repeat(40),
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1000,
    ...overrides,
  };
}

function sampleEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'row_000001',
    eventId: 'evt_001',
    occurredAt: new Date('2026-05-13T12:00:00.000Z'),
    actorUserId: 'user_001',
    actorRole: 'super_admin',
    actorTenantScopeType: 'global',
    actorTenantScopeId: null,
    action: 'subscription:write',
    resourceKind: 'subscription',
    resourceId: 'sub_001',
    beforeJson: { status: 'past_due' },
    afterJson: { status: 'active' },
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    requestId: 'req_001',
    traceId: 'trace_001',
    chainPrevHash: null,
    chainHash: 'c'.repeat(64),
    createdAt: new Date('2026-05-13T12:00:01.000Z'),
    ...overrides,
  };
}

class StubAuditService {
  public recordedCalls: RecordEventInput[] = [];
  public recordReturn: RecordEventResult = {
    outcome: 'recorded',
    event: sampleEvent(),
  };
  public listByResourceReturn: ListResult = { events: [sampleEvent()], nextCursor: null };
  public listByActorReturn: ListResult = { events: [sampleEvent()], nextCursor: null };
  public listByResourceCalls: ListByResourceQuery[] = [];
  public listByActorCalls: ListByActorQuery[] = [];

  async recordEvent(input: RecordEventInput): Promise<RecordEventResult> {
    this.recordedCalls.push(input);
    return this.recordReturn;
  }

  async listByResource(query: ListByResourceQuery): Promise<ListResult> {
    this.listByResourceCalls.push(query);
    return this.listByResourceReturn;
  }

  async listByActor(query: ListByActorQuery): Promise<ListResult> {
    this.listByActorCalls.push(query);
    return this.listByActorReturn;
  }
}

function fakeRequestWithHeader(headerName: string, headerValue: string | undefined) {
  return {
    header: (name: string): string | undefined => {
      if (name.toLowerCase() === headerName.toLowerCase()) return headerValue;
      return undefined;
    },
    requestContext: { userId: 'admin_001', roles: [] },
    headers: {},
    url: '/api/v1/internal/audit/events',
    method: 'POST',
  } as unknown as Parameters<typeof AuditController.prototype.recordEvent>[1];
}

describe('AuditController.recordEvent', () => {
  it('rejects when the shared-secret header is missing', async () => {
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const body = {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };
    const req = fakeRequestWithHeader('x-internal-api-key', undefined);

    await expect(controller.recordEvent(body, req as unknown as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(stub.recordedCalls).toHaveLength(0);
  });

  it('rejects when the shared-secret header value is wrong', async () => {
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const body = {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };
    const req = fakeRequestWithHeader(
      'x-internal-api-key',
      'wrong-value-padded-to-40-characters____',
    );

    await expect(controller.recordEvent(body, req as unknown as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(stub.recordedCalls).toHaveLength(0);
  });

  it('accepts a request with the correct shared-secret header and returns recorded outcome', async () => {
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const body = {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };
    const req = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);

    const response = await controller.recordEvent(body, req as unknown as never);

    expect(response.outcome).toBe('recorded');
    expect(response.event.eventId).toBe('evt_001');
    expect(stub.recordedCalls).toHaveLength(1);
    expect(stub.recordedCalls[0]?.eventId).toBe('evt_001');
    expect(stub.recordedCalls[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it('translates a replayed outcome into the response', async () => {
    const stub = new StubAuditService();
    stub.recordReturn = { outcome: 'replayed', event: sampleEvent() };
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const body = {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };
    const req = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);

    const response = await controller.recordEvent(body, req as unknown as never);
    expect(response.outcome).toBe('replayed');
  });

  it('honours a custom AUDIT_INGEST_HEADER_NAME', async () => {
    const stub = new StubAuditService();
    const env = buildEnv({ AUDIT_INGEST_HEADER_NAME: 'x-tns-ingest' });
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const body = {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };

    // Wrong header name → unauthorized.
    const reqWrongHeader = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);
    await expect(
      controller.recordEvent(body, reqWrongHeader as unknown as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Right header name → success.
    const reqRightHeader = fakeRequestWithHeader('x-tns-ingest', env.AUDIT_INGEST_API_KEY);
    const response = await controller.recordEvent(body, reqRightHeader as unknown as never);
    expect(response.outcome).toBe('recorded');
  });
});

describe('AuditController.listByResource', () => {
  it('passes the query through to the service', async () => {
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const result = await controller.listByResource(
      {
        resourceKind: 'subscription',
        resourceId: 'sub_001',
        limit: 25,
      },
      { requestContext: { userId: 'admin_001', roles: [] } } as never,
    );

    expect(stub.listByResourceCalls).toHaveLength(1);
    expect(stub.listByResourceCalls[0]?.resourceKind).toBe('subscription');
    expect(stub.listByResourceCalls[0]?.limit).toBe(25);
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });
});

describe('AuditController.listByActor', () => {
  it('passes the query through to the service', async () => {
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, makeStore());

    const result = await controller.listByActor(
      {
        actorUserId: 'user_001',
        limit: 10,
      },
      { requestContext: { userId: 'admin_001', roles: [] } } as never,
    );

    expect(stub.listByActorCalls).toHaveLength(1);
    expect(stub.listByActorCalls[0]?.actorUserId).toBe('user_001');
    expect(stub.listByActorCalls[0]?.limit).toBe(10);
    expect(result.events).toHaveLength(1);
  });
});

/**
 * Tenant-scope exempt-wrap contract (TS-020-followup-2b-platform-rollout).
 *
 * `AuditController.recordEvent` is the only Prisma-touching pre-auth /
 * internal surface in service-audit. The endpoint authenticates via a
 * shared-secret header (`AUDIT_INGEST_API_KEY`), NOT `AccessTokenGuard`,
 * so the `TenantContextInterceptor` cannot seed a scoped frame from a
 * `request.requestContext` that does not exist. Without an explicit
 * exempt wrap, every Prisma operation downstream would hard-fail with
 * `MissingRequestContextError` under the `enforcement: 'enforce'`
 * posture wired in `AppModule`.
 *
 * These tests pin the wrap by passing a real `TenantContextStore` + a
 * fake `AuditService` that captures `store.current()` at call time. The
 * captured frame must be `{ kind: 'exempt', reason:
 * 'internal-audit-event-record' }` — the precise reason string the
 * audit-log scanner will surface, so a future "no-context" Prisma access
 * can be traced back to its internal-ingest source.
 *
 * Two additional cases pin the failure paths:
 *
 *   - Missing / wrong shared-secret header → 401 short-circuit BEFORE
 *     the service is invoked. The frame is still visible at the
 *     header-probe callsite (captured via the fake `request.header`
 *     callback), proving the wrap encloses the entire handler body
 *     including the auth check.
 *
 *   - The "frame does not leak" invariant — `store.current()` is `null`
 *     both BEFORE and AFTER the handler so the exempt frame is
 *     strictly scoped to the handler body.
 *
 * The two admin endpoints (`listByResource` / `listByActor`) are
 * deliberately NOT covered here — they sit behind `AccessTokenGuard` so
 * the `TenantContextInterceptor` seeds a scoped frame from the
 * access-token claims; the integration suite owns proving that path
 * end-to-end.
 */
describe('AuditController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  function makeBody() {
    return {
      eventId: 'evt_001',
      occurredAt: '2026-05-13T12:00:00.000Z',
      actorUserId: 'user_001',
      actorRole: 'super_admin',
      actorTenantScopeType: 'global' as const,
      actorTenantScopeId: null,
      action: 'subscription:write',
      resourceKind: 'subscription',
      resourceId: 'sub_001',
      beforeJson: null,
      afterJson: { status: 'active' },
      ip: null,
      userAgent: null,
      requestId: null,
      traceId: null,
    };
  }

  it('runs recordEvent inside an exempt frame with reason "internal-audit-event-record"', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const stub = new StubAuditService();
    stub.recordEvent = vi.fn(async (input: RecordEventInput) => {
      captured = store.current();
      return { outcome: 'recorded' as const, event: sampleEvent({ eventId: input.eventId }) };
    });
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, store);
    const req = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);

    await controller.recordEvent(makeBody(), req as unknown as never);

    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-audit-event-record',
    });
  });

  it('captures the frame at the header-probe callsite even on the 401 short-circuit', async () => {
    const store = makeStore();
    let capturedAtHeaderProbe: TenantContextFrame | null = null;
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, store);
    const req = {
      header: (name: string): string | undefined => {
        if (name.toLowerCase() === 'x-internal-api-key') {
          // Capture the frame at the moment the handler probes the
          // shared-secret header — this proves the wrap encloses the
          // auth check, not just the service call.
          capturedAtHeaderProbe = store.current();
          return undefined;
        }
        return undefined;
      },
    } as unknown as Parameters<typeof AuditController.prototype.recordEvent>[1];

    await expect(controller.recordEvent(makeBody(), req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(capturedAtHeaderProbe).toEqual({
      kind: 'exempt',
      reason: 'internal-audit-event-record',
    });
    // The 401 short-circuit MUST happen before the service is invoked.
    expect(stub.recordedCalls).toHaveLength(0);
  });

  it('captures the frame at the service callsite when outcome is replayed', async () => {
    const store = makeStore();
    let captured: TenantContextFrame | null = null;
    const stub = new StubAuditService();
    stub.recordEvent = vi.fn(async (input: RecordEventInput) => {
      captured = store.current();
      return { outcome: 'replayed' as const, event: sampleEvent({ eventId: input.eventId }) };
    });
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, store);
    const req = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);

    const response = await controller.recordEvent(makeBody(), req as unknown as never);
    expect(response.outcome).toBe('replayed');
    expect(captured).toEqual({
      kind: 'exempt',
      reason: 'internal-audit-event-record',
    });
  });

  it('does not leak the exempt frame outside the handler', async () => {
    const store = makeStore();
    const stub = new StubAuditService();
    const env = buildEnv();
    const controller = new AuditController(stub as unknown as AuditService, env, store);
    const req = fakeRequestWithHeader('x-internal-api-key', env.AUDIT_INGEST_API_KEY);

    expect(store.current()).toBeNull();
    await controller.recordEvent(makeBody(), req as unknown as never);
    expect(store.current()).toBeNull();
  });
});
