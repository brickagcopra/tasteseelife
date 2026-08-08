import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import {
  ActivityService,
  type ActivityEvent,
  type ListByUserQuery,
  type ListResult,
  type RecordEventInput,
  type RecordEventResult,
} from '../services/activity.service';

import { ActivityController } from './activity.controller';

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3018,
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
    ACTIVITY_INGEST_HEADER_NAME: 'x-internal-api-key',
    ACTIVITY_INGEST_API_KEY: 'k'.repeat(40),
    REDIS_URL: 'redis://localhost:6379',
    IDEMPOTENCY_TTL_SECONDS: 86_400,
    IDEMPOTENCY_IN_FLIGHT_TTL_SECONDS: 60,
    ...overrides,
  };
}

function sampleEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: 'row_000001',
    eventId: 'evt_001',
    userId: 'user_001',
    kind: 'login_success',
    occurredAt: new Date('2026-05-14T12:00:00.000Z'),
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0',
    deviceFingerprint: 'fpr_abc',
    requestId: 'req_001',
    traceId: 'trace_001',
    metadata: { app: 'web' },
    createdAt: new Date('2026-05-14T12:00:01.000Z'),
    ...overrides,
  };
}

class StubActivityService {
  public recordedCalls: RecordEventInput[] = [];
  public recordReturn: RecordEventResult = {
    outcome: 'recorded',
    event: sampleEvent(),
  };
  public listByUserCalls: ListByUserQuery[] = [];
  public listByUserReturn: ListResult = { events: [sampleEvent()], nextCursor: null };

  async recordEvent(input: RecordEventInput): Promise<RecordEventResult> {
    this.recordedCalls.push(input);
    return this.recordReturn;
  }

  async listByUser(query: ListByUserQuery): Promise<ListResult> {
    this.listByUserCalls.push(query);
    return this.listByUserReturn;
  }
}

function fakeRequestWithHeader(headerName: string, headerValue: string | undefined) {
  return {
    header: (name: string): string | undefined => {
      if (name.toLowerCase() === headerName.toLowerCase()) return headerValue;
      return undefined;
    },
    headers: {},
    url: '/api/v1/internal/activity/events',
    method: 'POST',
  } as unknown as Parameters<typeof ActivityController.prototype.recordEvent>[1];
}

function authedRequest(actorUserId: string | undefined) {
  return {
    requestContext:
      actorUserId === undefined
        ? undefined
        : { userId: actorUserId, mfaVerified: true, roles: [], tenantScope: { type: 'global' } },
    headers: {},
    url: '/api/v1/users/me/activity',
    method: 'GET',
  } as never;
}

describe('ActivityController.recordEvent', () => {
  const baseBody = {
    eventId: 'evt_001',
    userId: 'user_001',
    kind: 'login_success' as const,
    occurredAt: '2026-05-14T12:00:00.000Z',
    ip: null,
    userAgent: null,
    deviceFingerprint: null,
    requestId: null,
    traceId: null,
    metadata: null,
  };

  it('rejects when the shared-secret header is missing', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const req = fakeRequestWithHeader('x-internal-api-key', undefined);

    await expect(controller.recordEvent(baseBody, req as unknown as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(stub.recordedCalls).toHaveLength(0);
  });

  it('rejects when the shared-secret header value is wrong (same length)', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const req = fakeRequestWithHeader(
      'x-internal-api-key',
      'x'.repeat(env.ACTIVITY_INGEST_API_KEY.length),
    );

    await expect(controller.recordEvent(baseBody, req as unknown as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects when the shared-secret header value is wrong length', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const req = fakeRequestWithHeader('x-internal-api-key', 'short');

    await expect(controller.recordEvent(baseBody, req as unknown as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('accepts a request with the correct shared-secret and returns recorded outcome', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const req = fakeRequestWithHeader('x-internal-api-key', env.ACTIVITY_INGEST_API_KEY);

    const response = await controller.recordEvent(baseBody, req as unknown as never);

    expect(response.outcome).toBe('recorded');
    expect(response.event.eventId).toBe('evt_001');
    expect(stub.recordedCalls).toHaveLength(1);
    expect(stub.recordedCalls[0]?.eventId).toBe('evt_001');
    expect(stub.recordedCalls[0]?.occurredAt).toBeInstanceOf(Date);
  });

  it('translates a replayed outcome into the response', async () => {
    const stub = new StubActivityService();
    stub.recordReturn = { outcome: 'replayed', event: sampleEvent() };
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const req = fakeRequestWithHeader('x-internal-api-key', env.ACTIVITY_INGEST_API_KEY);

    const response = await controller.recordEvent(baseBody, req as unknown as never);
    expect(response.outcome).toBe('replayed');
  });

  it('honours a custom ACTIVITY_INGEST_HEADER_NAME', async () => {
    const stub = new StubActivityService();
    const env = buildEnv({ ACTIVITY_INGEST_HEADER_NAME: 'x-tns-ingest' });
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    // Wrong header name → unauthorized.
    const reqWrong = fakeRequestWithHeader('x-internal-api-key', env.ACTIVITY_INGEST_API_KEY);
    await expect(
      controller.recordEvent(baseBody, reqWrong as unknown as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Right header name → success.
    const reqRight = fakeRequestWithHeader('x-tns-ingest', env.ACTIVITY_INGEST_API_KEY);
    const response = await controller.recordEvent(baseBody, reqRight as unknown as never);
    expect(response.outcome).toBe('recorded');
  });
});

describe('ActivityController.listMyActivity', () => {
  it('passes the actor userId through to the service', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const result = await controller.listMyActivity(
      { limit: 25 },
      authedRequest('user_001') as never,
    );

    expect(stub.listByUserCalls).toHaveLength(1);
    expect(stub.listByUserCalls[0]?.userId).toBe('user_001');
    expect(stub.listByUserCalls[0]?.limit).toBe(25);
    expect(stub.listByUserCalls[0]?.kindFilter).toBeUndefined();
    expect(result.events).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it('forwards the optional kind filter', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    await controller.listMyActivity(
      { kind: 'login_failure', limit: 10 },
      authedRequest('user_001') as never,
    );

    expect(stub.listByUserCalls[0]?.kindFilter).toBe('login_failure');
  });

  it('rejects when the request context has no actor userId', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    await expect(
      controller.listMyActivity({ limit: 10 }, authedRequest(undefined) as never),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(stub.listByUserCalls).toHaveLength(0);
  });

  it('does NOT accept a userId query param (actor cannot peek at another user)', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    // Even if a malicious-looking userId leaked through validation,
    // the service is always called with the actor's id from the
    // access token — never with anything from the query string.
    await controller.listMyActivity({ limit: 10 }, authedRequest('user_alice') as never);
    expect(stub.listByUserCalls[0]?.userId).toBe('user_alice');
  });
});

describe('ActivityController.listUserActivity', () => {
  it('passes the path userId through to the service', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    const result = await controller.listUserActivity(
      'user_target',
      { limit: 10 },
      authedRequest('admin_001') as never,
    );

    expect(stub.listByUserCalls[0]?.userId).toBe('user_target');
    expect(stub.listByUserCalls[0]?.limit).toBe(10);
    expect(result.events).toHaveLength(1);
  });

  it('rejects an empty userId path parameter', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    await expect(
      controller.listUserActivity('', { limit: 10 }, authedRequest('admin_001') as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stub.listByUserCalls).toHaveLength(0);
  });

  it('forwards the optional kind filter on the admin endpoint', async () => {
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, makeStore());

    await controller.listUserActivity(
      'user_target',
      { kind: 'suspicious_activity_flag', limit: 10 },
      authedRequest('admin_001') as never,
    );
    expect(stub.listByUserCalls[0]?.kindFilter).toBe('suspicious_activity_flag');
  });
});

describe('ActivityController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  const baseBody = {
    eventId: 'evt_wrap_001',
    userId: 'user_001',
    kind: 'login_success' as const,
    occurredAt: '2026-05-14T12:00:00.000Z',
    ip: null,
    userAgent: null,
    deviceFingerprint: null,
    requestId: null,
    traceId: null,
    metadata: null,
  };

  it('seeds an exempt frame at the activity.recordEvent collaborator callsite', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const fakeSvc = {
      async recordEvent(_input: RecordEventInput): Promise<RecordEventResult> {
        observedFrame = store.current();
        return {
          outcome: 'recorded',
          event: sampleEvent({ eventId: 'evt_wrap_001' }),
        };
      },
      async listByUser(_q: ListByUserQuery): Promise<ListResult> {
        return { events: [], nextCursor: null };
      },
    };
    const env = buildEnv();
    const controller = new ActivityController(fakeSvc as unknown as ActivityService, env, store);
    const req = fakeRequestWithHeader('x-internal-api-key', env.ACTIVITY_INGEST_API_KEY);

    expect(store.current()).toBeNull();
    await controller.recordEvent(baseBody, req as unknown as never);
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-activity-event-record',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 401 short-circuit path (the header lookup runs inside the wrap)', async () => {
    const store = makeStore();
    let observedFrame: TenantContextFrame | null = null;
    const probingHeader = (name: string): string | undefined => {
      observedFrame = store.current();
      return name.toLowerCase() === 'x-internal-api-key' ? undefined : undefined;
    };
    const req = {
      header: probingHeader,
      headers: {},
      url: '/api/v1/internal/activity/events',
      method: 'POST',
    } as unknown as Parameters<typeof ActivityController.prototype.recordEvent>[1];

    const stub = new StubActivityService();
    const controller = new ActivityController(
      stub as unknown as ActivityService,
      buildEnv(),
      store,
    );
    await expect(controller.recordEvent(baseBody, req)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-activity-event-record',
    });
    expect(store.current()).toBeNull();
    expect(stub.recordedCalls).toHaveLength(0);
  });

  it('does not leak a frame outside the wrap on the happy path', async () => {
    const store = makeStore();
    const stub = new StubActivityService();
    const env = buildEnv();
    const controller = new ActivityController(stub as unknown as ActivityService, env, store);
    const req = fakeRequestWithHeader('x-internal-api-key', env.ACTIVITY_INGEST_API_KEY);

    expect(store.current()).toBeNull();
    await controller.recordEvent(baseBody, req as unknown as never);
    expect(store.current()).toBeNull();
  });
});
