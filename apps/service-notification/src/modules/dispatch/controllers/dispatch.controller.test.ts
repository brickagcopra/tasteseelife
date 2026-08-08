import { UnauthorizedException } from '@nestjs/common';
import type { DispatchNotificationRequest } from '@taste-and-see/contracts';
import {
  TenantContextStore,
  type TenantContextFrame,
} from '@taste-and-see/nest-prisma-tenant-scope';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import type { Env } from '../../../config/env';
import type { DispatchOrchestratorService } from '../services/dispatch-orchestrator.service';

import { DispatchController } from './dispatch.controller';

function buildEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3017,
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
    NOTIFICATION_RENDER_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_RENDER_API_KEY: 'k'.repeat(40),
    NOTIFICATION_DISPATCH_HEADER_NAME: 'x-internal-api-key',
    NOTIFICATION_DISPATCH_API_KEY: 'd'.repeat(40),
    NOTIFICATION_EMAIL_FROM_ADDRESS: 'no-reply@example.com',
    NOTIFICATION_EMAIL_FROM_NAME: 'Taste & See',
    // TS-042-followup-3a2 — the dunning-consumer env cluster.
    REDIS_URL: 'redis://localhost:6379',
    OUTBOX_CONSUMER_NAME: 'default',
    OUTBOX_STREAM_PREFIX: 'events',
    OUTBOX_CONSUMER_MAX_ATTEMPTS: 10,
    OUTBOX_CONSUMER_POLL_BLOCK_MS: 5_000,
    OUTBOX_CONSUMER_RECLAIM_IDLE_MS: 60_000,
    OUTBOX_CONSUMER_POLL_INTERVAL_MS: 1_000,
    DUNNING_NOTIFICATIONS_ENABLED: true,
    HOUSEHOLD_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_SERVICE_BASE_URL: 'http://service-household:3011',
    PROVIDER_BILLING_CONTACTS_INTERNAL_API_KEY: 'p'.repeat(48),
    PROVIDER_BILLING_CONTACTS_INTERNAL_HEADER_NAME: 'x-provider-billing-contacts-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME: 'x-internal-api-key',
    HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY: 'a'.repeat(32),
    IDENTITY_SERVICE_BASE_URL: 'http://service-identity:3010',
    IDENTITY_RECIPIENT_CONTACTS_HEADER_NAME: 'x-internal-api-key',
    IDENTITY_RECIPIENT_CONTACTS_API_KEY: 'b'.repeat(32),
    DUNNING_BILLING_URL: 'https://app.example.com/billing/invoices',
    DUNNING_APP_NAME: 'Taste & See',
    EMAIL_VERIFICATION_URL_BASE: 'http://localhost:3000/verify-email',
    EMAIL_VERIFICATION_NOTIFICATIONS_ENABLED: true,
  };
}

function makeStore(): TenantContextStore {
  return new TenantContextStore();
}

function buildRequest(headers: Record<string, string> = {}): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

interface FakeDispatchRow {
  readonly id: string;
  readonly recipientUserId: string;
  readonly channel: 'email' | 'sms' | 'push' | 'in_app';
  readonly category: 'transactional' | 'marketing' | 'system';
  readonly templateCode: string;
  readonly locale: 'en-US' | 'es-US' | 'zh-CN';
  readonly templateVersionId: string | null;
  readonly recipientAddress: string;
  readonly status: 'sent';
  readonly suppressionReason: null;
  readonly providerMessageId: string | null;
  readonly errorMessage: null;
  readonly idempotencyKey: string;
  readonly sourceEventId: string | null;
  readonly occurredAt: Date;
  readonly sentAt: Date;
}

const FAKE_ROW: FakeDispatchRow = {
  id: 'dsp_1',
  recipientUserId: 'usr_1',
  channel: 'email',
  category: 'transactional',
  templateCode: 'welcome',
  locale: 'en-US',
  templateVersionId: 'ver_1',
  recipientAddress: 'alice@example.com',
  status: 'sent',
  suppressionReason: null,
  providerMessageId: 'postmark_1',
  errorMessage: null,
  idempotencyKey: 'idem_dispatch_001',
  sourceEventId: null,
  occurredAt: new Date('2026-05-20T00:00:00.000Z'),
  sentAt: new Date('2026-05-20T00:00:01.000Z'),
};

interface FakeDispatchResult {
  readonly dispatch: FakeDispatchRow;
  readonly replayed: boolean;
}

class FakeOrchestrator {
  // Test seam: when set, the dispatch method records `store.current()`
  // at invocation time. Lets the wrap test pin the seeded frame at
  // the collaborator's callsite.
  captureStore: TenantContextStore | null = null;
  capturedFrame: TenantContextFrame | null = null;

  async dispatch(_body: DispatchNotificationRequest): Promise<FakeDispatchResult> {
    if (this.captureStore !== null) {
      this.capturedFrame = this.captureStore.current();
    }
    return { dispatch: FAKE_ROW, replayed: false };
  }
}

const BASE_REQUEST: DispatchNotificationRequest = {
  recipientUserId: 'usr_1',
  channel: 'email',
  category: 'transactional',
  templateCode: 'welcome',
  locale: 'en-US',
  recipientAddress: 'alice@example.com',
  variables: {},
  idempotencyKey: 'idem_dispatch_001',
  bypassQuietHours: false,
};

describe('DispatchController.dispatch base behaviour', () => {
  it('rejects a request missing the shared-secret header with 401', async () => {
    const orch = new FakeOrchestrator();
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      makeStore(),
    );
    await expect(controller.dispatch(BASE_REQUEST, buildRequest({}))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a request with a wrong-value shared-secret header with 401', async () => {
    const orch = new FakeOrchestrator();
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      makeStore(),
    );
    await expect(
      controller.dispatch(BASE_REQUEST, buildRequest({ 'x-internal-api-key': 'x'.repeat(40) })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns the dispatch DTO on success', async () => {
    const orch = new FakeOrchestrator();
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      makeStore(),
    );
    const result = await controller.dispatch(
      BASE_REQUEST,
      buildRequest({ 'x-internal-api-key': 'd'.repeat(40) }),
    );
    expect(result.id).toBe('dsp_1');
    expect(result.status).toBe('sent');
  });

  it('honours a custom NOTIFICATION_DISPATCH_HEADER_NAME override', async () => {
    const orch = new FakeOrchestrator();
    const env: Env = {
      ...buildEnv(),
      NOTIFICATION_DISPATCH_HEADER_NAME: 'x-tns-dispatch',
    };
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      env,
      makeStore(),
    );
    const result = await controller.dispatch(
      BASE_REQUEST,
      buildRequest({ 'x-tns-dispatch': 'd'.repeat(40) }),
    );
    expect(result.id).toBe('dsp_1');
  });
});

describe('DispatchController tenant-scope exempt wrap (TS-020-followup-2b-platform-rollout)', () => {
  it('seeds an exempt frame at the orchestrator.dispatch collaborator callsite', async () => {
    const store = makeStore();
    const orch = new FakeOrchestrator();
    orch.captureStore = store;
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      store,
    );
    expect(store.current()).toBeNull();
    await controller.dispatch(BASE_REQUEST, buildRequest({ 'x-internal-api-key': 'd'.repeat(40) }));
    expect(orch.capturedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-notification-dispatch',
    });
    expect(store.current()).toBeNull();
  });

  it('seeds the exempt frame on the 401 short-circuit path (the header lookup runs inside the wrap)', async () => {
    const store = makeStore();
    const orch = new FakeOrchestrator();
    let observedFrame: TenantContextFrame | null = null;
    const probingHeader = (_name: string): string | undefined => {
      observedFrame = store.current();
      return undefined;
    };
    const request = { header: probingHeader } as unknown as Request;
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      store,
    );
    await expect(controller.dispatch(BASE_REQUEST, request)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(observedFrame).toEqual({
      kind: 'exempt',
      reason: 'internal-notification-dispatch',
    });
    expect(store.current()).toBeNull();
  });

  it('does not leak the exempt frame after the handler resolves', async () => {
    const store = makeStore();
    const orch = new FakeOrchestrator();
    const controller = new DispatchController(
      orch as unknown as DispatchOrchestratorService,
      buildEnv(),
      store,
    );
    expect(store.current()).toBeNull();
    await controller.dispatch(BASE_REQUEST, buildRequest({ 'x-internal-api-key': 'd'.repeat(40) }));
    expect(store.current()).toBeNull();
  });
});
