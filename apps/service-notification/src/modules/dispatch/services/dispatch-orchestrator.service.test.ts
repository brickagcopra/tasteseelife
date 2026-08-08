import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { TemplatesService } from '../../templates/services/templates.service';

import { EmailDispatcher } from '../channels/email-dispatcher.service';
import { PushDispatcher } from '../channels/push-dispatcher.service';
import { SmsDispatcher } from '../channels/sms-dispatcher.service';

import { DispatchOrchestratorService } from './dispatch-orchestrator.service';
import type { PreferenceGateService } from './preference-gate.service';

type Channel = 'email' | 'sms' | 'push' | 'in_app';
type Category = 'transactional' | 'marketing' | 'system';
type Status =
  | 'queued'
  | 'sent'
  | 'failed'
  | 'suppressed_by_preference'
  | 'suppressed_by_quiet_hours'
  | 'suppressed_by_unsubscribed';

interface DispatchPrismaRow {
  id: string;
  recipientUserId: string;
  channel: Channel;
  category: Category;
  templateCode: string;
  locale: 'en_US' | 'es_US' | 'zh_CN';
  templateId: string | null;
  templateVersionId: string | null;
  recipientAddress: string;
  status: Status;
  suppressionReason: string | null;
  providerMessageId: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  bypassQuietHours: boolean;
  occurredAt: Date;
  sentAt: Date | null;
}

class FakeDispatchPrisma {
  rows: DispatchPrismaRow[] = [];
  private nextSeq = 1;

  notificationDispatch = {
    findUnique: async ({
      where,
    }: {
      where: { idempotencyKey?: string; id?: string };
    }): Promise<DispatchPrismaRow | null> => {
      if (where.idempotencyKey) {
        return this.rows.find((r) => r.idempotencyKey === where.idempotencyKey) ?? null;
      }
      if (where.id) {
        return this.rows.find((r) => r.id === where.id) ?? null;
      }
      return null;
    },

    create: async ({
      data,
    }: {
      data: Omit<DispatchPrismaRow, 'id'>;
    }): Promise<DispatchPrismaRow> => {
      const row: DispatchPrismaRow = {
        id: `disp_${String(this.nextSeq).padStart(4, '0')}`,
        ...data,
      };
      this.nextSeq += 1;
      this.rows.push(row);
      return row;
    },

    findMany: async ({
      where,
      take,
    }: {
      where?: Partial<DispatchPrismaRow>;
      orderBy?: unknown;
      take?: number;
    }): Promise<DispatchPrismaRow[]> => {
      let rows = [...this.rows].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
      if (where) {
        rows = rows.filter((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (v === undefined) continue;
            const value = r[k as keyof DispatchPrismaRow];
            if (value !== v) return false;
          }
          return true;
        });
      }
      return take ? rows.slice(0, take) : rows;
    },
  };
}

function makeEnv(): Env {
  return {
    NODE_ENV: 'test',
    PORT: 3017,
    LOG_LEVEL: 'info',
    DATABASE_URL: 'postgresql://x',
    SERVICE_VERSION: 'dev',
    OTEL_TRACES_ENABLED: false,
    OTEL_METRICS_ENABLED: false,
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    INTERNAL_TRUST_SIGNING_SECRET: 't'.repeat(32),
    INTERNAL_TRUST_MAX_AGE_SECONDS: 60,
    JWT_ISSUER: 'iss',
    JWT_AUDIENCE: 'aud',
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
  } as Env;
}

function makeTemplatesService(
  result:
    | {
        outcome: 'ok';
        rendered: {
          templateCode: string;
          locale: 'en-US' | 'es-US' | 'zh-CN';
          kind: Channel;
          version: number;
          subject: string | null;
          bodyHtml: string | null;
          bodyText: string | null;
        };
      }
    | { outcome: 'failed'; failure: { kind: string; [k: string]: unknown } },
): TemplatesService {
  return { render: vi.fn().mockResolvedValue(result) } as unknown as TemplatesService;
}

function makeGate(
  allow: boolean,
  suppressionReason?: 'preference_opted_out' | 'quiet_hours' | 'globally_unsubscribed',
): PreferenceGateService {
  return {
    decide: vi
      .fn()
      .mockResolvedValue(allow ? { allow: true } : { allow: false, suppressionReason }),
  } as unknown as PreferenceGateService;
}

function makeOrchestrator(opts: {
  prisma?: FakeDispatchPrisma;
  templates?: TemplatesService;
  gate?: PreferenceGateService;
}): { service: DispatchOrchestratorService; prisma: FakeDispatchPrisma } {
  const prisma = opts.prisma ?? new FakeDispatchPrisma();
  const env = makeEnv();
  const service = new DispatchOrchestratorService(
    prisma as unknown as PrismaService,
    opts.templates ??
      makeTemplatesService({
        outcome: 'ok',
        rendered: {
          templateCode: 'welcome',
          locale: 'en-US',
          kind: 'email',
          version: 1,
          subject: 'Welcome!',
          bodyHtml: '<p>Hi</p>',
          bodyText: 'Hi',
        },
      }),
    opts.gate ?? makeGate(true),
    // `null` client — the orchestrator suite exercises routing and
    // persistence, and these envs carry no POSTMARK_SERVER_TOKEN, so the
    // dispatcher stays in stub mode and opens no socket.
    new EmailDispatcher(env, null),
    new SmsDispatcher(env),
    new PushDispatcher(env),
    env,
  );
  return { service, prisma };
}

function makeRequest(
  overrides: Record<string, unknown> = {},
): Parameters<DispatchOrchestratorService['dispatch']>[0] {
  return {
    recipientUserId: 'user_abc',
    channel: 'email',
    category: 'transactional',
    templateCode: 'welcome',
    locale: 'en-US',
    recipientAddress: 'recipient@example.com',
    idempotencyKey: 'idempotency-key-0123456789',
    bypassQuietHours: false,
    ...overrides,
  } as Parameters<DispatchOrchestratorService['dispatch']>[0];
}

describe('DispatchOrchestratorService.dispatch', () => {
  it('persists a sent row when the gate allows + render + send succeed', async () => {
    const { service, prisma } = makeOrchestrator({});
    const result = await service.dispatch(makeRequest());

    expect(result.replayed).toBe(false);
    expect(result.dispatch.status).toBe('sent');
    expect(result.dispatch.providerMessageId).toMatch(/^stub-/);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({ status: 'sent', suppressionReason: null });
  });

  it('returns the existing row as replayed when idempotency key already exists', async () => {
    const { service, prisma } = makeOrchestrator({});
    await service.dispatch(makeRequest());
    expect(prisma.rows).toHaveLength(1);

    const replayed = await service.dispatch(makeRequest());
    expect(replayed.replayed).toBe(true);
    expect(replayed.dispatch.id).toBe(prisma.rows[0]?.id);
    // No new row inserted.
    expect(prisma.rows).toHaveLength(1);
  });

  it('persists a suppressed_by_preference row when the gate denies on opt-out', async () => {
    const { service, prisma } = makeOrchestrator({
      gate: makeGate(false, 'preference_opted_out'),
    });
    const result = await service.dispatch(makeRequest({ category: 'marketing' }));

    expect(result.dispatch.status).toBe('suppressed_by_preference');
    expect(result.dispatch.suppressionReason).toBe('preference_opted_out');
    expect(prisma.rows[0]?.providerMessageId).toBeNull();
  });

  it('persists a suppressed_by_quiet_hours row when the gate denies on quiet hours', async () => {
    const { service } = makeOrchestrator({
      gate: makeGate(false, 'quiet_hours'),
    });
    const result = await service.dispatch(makeRequest());
    expect(result.dispatch.status).toBe('suppressed_by_quiet_hours');
    expect(result.dispatch.suppressionReason).toBe('quiet_hours');
  });

  it('persists a suppressed_by_unsubscribed row on globally_unsubscribed', async () => {
    const { service } = makeOrchestrator({
      gate: makeGate(false, 'globally_unsubscribed'),
    });
    const result = await service.dispatch(makeRequest());
    expect(result.dispatch.status).toBe('suppressed_by_unsubscribed');
    expect(result.dispatch.suppressionReason).toBe('globally_unsubscribed');
  });

  it('persists a failed row when the template render fails', async () => {
    const { service } = makeOrchestrator({
      templates: makeTemplatesService({
        outcome: 'failed',
        failure: { kind: 'template_or_active_version_not_found' },
      }),
    });
    const result = await service.dispatch(makeRequest());
    expect(result.dispatch.status).toBe('failed');
    expect(result.dispatch.errorMessage).toBe('template_or_active_version_not_found');
  });

  it('persists a failed row on variable_validation_failed', async () => {
    const { service } = makeOrchestrator({
      templates: makeTemplatesService({
        outcome: 'failed',
        failure: {
          kind: 'variable_validation_failed',
          issues: [
            {
              kind: 'missing_required',
              variableName: 'name',
              message: 'required variable name missing',
            },
          ],
        },
      }),
    });
    const result = await service.dispatch(makeRequest());
    expect(result.dispatch.status).toBe('failed');
    expect(result.dispatch.errorMessage).toContain('variable_validation_failed');
  });

  it('returns a failed row for the in_app channel (TS-071 not yet shipped)', async () => {
    const { service } = makeOrchestrator({});
    const result = await service.dispatch(makeRequest({ channel: 'in_app' }));
    expect(result.dispatch.status).toBe('failed');
    expect(result.dispatch.errorMessage).toContain('in_app');
  });

  it('persists a failed row when the SMS dispatcher rejects the recipient', async () => {
    const { service } = makeOrchestrator({
      templates: makeTemplatesService({
        outcome: 'ok',
        rendered: {
          templateCode: 'otp',
          locale: 'en-US',
          kind: 'sms',
          version: 1,
          subject: null,
          bodyHtml: null,
          bodyText: 'Your code is 123456',
        },
      }),
    });
    const result = await service.dispatch(
      makeRequest({ channel: 'sms', recipientAddress: 'not-e164' }),
    );
    expect(result.dispatch.status).toBe('failed');
  });

  it('routes a push dispatch through the push adapter', async () => {
    const { service } = makeOrchestrator({
      templates: makeTemplatesService({
        outcome: 'ok',
        rendered: {
          templateCode: 'reminder',
          locale: 'en-US',
          kind: 'push',
          version: 1,
          subject: 'Reminder',
          bodyHtml: null,
          bodyText: 'Visit at 10:00',
        },
      }),
    });
    const result = await service.dispatch(
      makeRequest({ channel: 'push', recipientAddress: 'fcm-token-abc123def456' }),
    );
    expect(result.dispatch.status).toBe('sent');
    expect(result.dispatch.channel).toBe('push');
  });

  it('persists the source event id when supplied', async () => {
    const { service, prisma } = makeOrchestrator({});
    await service.dispatch(makeRequest({ sourceEventId: 'evt_outbox_001' }));
    expect(prisma.rows[0]?.sourceEventId).toBe('evt_outbox_001');
  });

  it('stamps sentAt strictly after occurredAt', async () => {
    const { service } = makeOrchestrator({});
    const result = await service.dispatch(makeRequest());
    expect(result.dispatch.sentAt).not.toBeNull();
    if (result.dispatch.sentAt) {
      expect(result.dispatch.sentAt.getTime()).toBeGreaterThan(
        result.dispatch.occurredAt.getTime(),
      );
    }
  });
});

describe('DispatchOrchestratorService.list', () => {
  it('returns dispatches newest first', async () => {
    const { service } = makeOrchestrator({});
    await service.dispatch(makeRequest({ idempotencyKey: 'idempotency-key-1111111111' }));
    await service.dispatch(makeRequest({ idempotencyKey: 'idempotency-key-2222222222' }));
    const list = await service.list({ limit: 10 });
    expect(list.rows).toHaveLength(2);
    expect(list.nextCursor).toBeNull();
  });

  it('returns a cursor when more rows are available', async () => {
    const { service } = makeOrchestrator({});
    for (let i = 0; i < 3; i += 1) {
      await service.dispatch(
        makeRequest({ idempotencyKey: `idempotency-key-${String(i).padStart(20, '0')}` }),
      );
    }
    const page = await service.list({ limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it('filters by channel + status', async () => {
    const { service } = makeOrchestrator({
      gate: makeGate(false, 'preference_opted_out'),
    });
    await service.dispatch(makeRequest({ idempotencyKey: 'idempotency-key-3333333333' }));
    const allowed = makeOrchestrator({});
    await allowed.service.dispatch(makeRequest({ idempotencyKey: 'idempotency-key-4444444444' }));

    const list = await service.list({ limit: 10, status: 'suppressed_by_preference' });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]?.status).toBe('suppressed_by_preference');
  });
});
