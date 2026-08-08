import { randomBytes } from 'node:crypto';

import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import { normalizeKycEventTypeLabel } from '../kyc-metrics';
import { KycPayloadCipherService } from './kyc-payload-cipher.service';
import { KycService, type KycRecordStatus as KycStatus } from './kyc.service';
import {
  StripeIdentityClient,
  type StripeIdentityFailure,
  type StripeIdentitySession,
} from './stripe-identity.client';
import { err, ok, type Result } from './result';

type FakeKycRow = {
  id: string;
  userId: string;
  provider: 'stripe_identity';
  status: KycStatus;
  externalId: string;
  payloadCiphertext: Buffer | null;
  payloadIv: Buffer | null;
  payloadAuthTag: Buffer | null;
  payloadKeyVersion: number | null;
  lastEventId: string | null;
  verifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * In-memory Prisma stand-in mirroring the surface KycService touches:
 * `kycRecord.create`, `kycRecord.findUnique({ where: { externalId } })`,
 * `kycRecord.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } })`,
 * and `kycRecord.update`.
 *
 * The shape leans on the Prisma-generated `KycRecord` type so a future
 * schema change (a new column, a renamed field) breaks the fake at
 * compile time — the same FakePrisma discipline used in
 * SubscriptionsService tests.
 */
class FakeKycPrisma {
  public rows: FakeKycRow[] = [];
  private idCounter = 0;

  kycRecord = {
    create: vi.fn(async (args: { data: Partial<FakeKycRow> }): Promise<FakeKycRow> => {
      this.idCounter += 1;
      const now = new Date();
      const row: FakeKycRow = {
        id: `kyc_${this.idCounter}`,
        userId: args.data.userId ?? '',
        provider: args.data.provider ?? 'stripe_identity',
        status: args.data.status ?? 'pending',
        externalId: args.data.externalId ?? '',
        payloadCiphertext: null,
        payloadIv: null,
        payloadAuthTag: null,
        payloadKeyVersion: null,
        lastEventId: null,
        verifiedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(row);
      return row;
    }),
    findUnique: vi.fn(
      async (args: { where: { externalId: string } }): Promise<FakeKycRow | null> => {
        return this.rows.find((r) => r.externalId === args.where.externalId) ?? null;
      },
    ),
    findFirst: vi.fn(
      async (args: {
        where: { userId: string };
        orderBy?: { createdAt: 'asc' | 'desc' };
      }): Promise<FakeKycRow | null> => {
        const matches = this.rows.filter((r) => r.userId === args.where.userId);
        if (matches.length === 0) return null;
        const order = args.orderBy?.createdAt ?? 'asc';
        matches.sort((a, b) =>
          order === 'desc'
            ? b.createdAt.getTime() - a.createdAt.getTime()
            : a.createdAt.getTime() - b.createdAt.getTime(),
        );
        return matches[0] ?? null;
      },
    ),
    update: vi.fn(
      async (args: { where: { id: string }; data: Partial<FakeKycRow> }): Promise<FakeKycRow> => {
        const idx = this.rows.findIndex((r) => r.id === args.where.id);
        if (idx === -1) throw new Error(`row ${args.where.id} not in fake`);
        const next = { ...this.rows[idx]!, ...args.data, updatedAt: new Date() } as FakeKycRow;
        this.rows[idx] = next;
        return next;
      },
    ),
  };
}

class FakeStripeIdentityClient {
  public lastCreateInput: Parameters<StripeIdentityClient['createVerificationSession']>[0] | null =
    null;
  public createResponse: Result<StripeIdentitySession, StripeIdentityFailure> = ok({
    id: 'vs_test_default',
    status: 'requires_input',
    clientSecret: 'cs_test_default',
    hostedUrl: 'https://verify.stripe.com/v1/test_default',
    verifiedAtSeconds: null,
  });

  async createVerificationSession(
    input: Parameters<StripeIdentityClient['createVerificationSession']>[0],
  ): Promise<Result<StripeIdentitySession, StripeIdentityFailure>> {
    this.lastCreateInput = input;
    return this.createResponse;
  }

  async retrieveVerificationSession(
    _sessionId: string,
  ): Promise<Result<StripeIdentitySession, StripeIdentityFailure>> {
    return ok({
      id: 'vs_test_default',
      status: 'requires_input',
      clientSecret: null,
      hostedUrl: null,
      verifiedAtSeconds: null,
    });
  }
}

function makeEnv(): Env {
  return {
    KYC_PAYLOAD_ENC_KEY: randomBytes(32).toString('base64'),
    KYC_PAYLOAD_ENC_KEY_VERSION: 1,
    STRIPE_IDENTITY_RETURN_URL: 'https://app.tasteandsee.com/onboarding/identity/complete',
  } as unknown as Env;
}

function makeKycService(): {
  service: KycService;
  prisma: FakeKycPrisma;
  stripe: FakeStripeIdentityClient;
} {
  const prisma = new FakeKycPrisma();
  const stripe = new FakeStripeIdentityClient();
  const env = makeEnv();
  const cipher = new KycPayloadCipherService(env);
  const service = new KycService(
    prisma as unknown as PrismaService,
    stripe as unknown as StripeIdentityClient,
    cipher,
    env,
  );
  return { service, prisma, stripe };
}

describe('KycService.startSession', () => {
  it('creates a pending row, asks Stripe for a session, returns client_secret + hostedUrl', async () => {
    const { service, prisma, stripe } = makeKycService();
    stripe.createResponse = ok({
      id: 'vs_abc',
      status: 'requires_input',
      clientSecret: 'cs_abc',
      hostedUrl: 'https://verify.stripe.com/v1/abc',
      verifiedAtSeconds: null,
    });

    const result = await service.startSession({ userId: 'user_1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.clientSecret).toBe('cs_abc');
    expect(result.value.hostedUrl).toBe('https://verify.stripe.com/v1/abc');
    expect(result.value.record.userId).toBe('user_1');
    expect(result.value.record.externalId).toBe('vs_abc');
    expect(result.value.record.status).toBe<KycStatus>('requires_input');
    expect(prisma.rows).toHaveLength(1);
    expect(stripe.lastCreateInput?.returnUrl).toBe(
      'https://app.tasteandsee.com/onboarding/identity/complete',
    );
  });

  it('forwards the Idempotency-Key to Stripe with a kyc-start: prefix', async () => {
    const { service, stripe } = makeKycService();
    await service.startSession({ userId: 'user_1', idempotencyKey: 'abc-123' });
    expect(stripe.lastCreateInput?.idempotencyKey).toBe('kyc-start:abc-123');
  });

  it('returns invalid_request when userId is empty', async () => {
    const { service } = makeKycService();
    const result = await service.startSession({ userId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('returns stripe_unavailable when Stripe rejects the create call', async () => {
    const { service, stripe } = makeKycService();
    stripe.createResponse = err({ reason: 'stripe_unavailable', cause: new Error('boom') });
    const result = await service.startSession({ userId: 'user_1' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('stripe_unavailable');
  });

  it('maps Stripe-reported status into our KycStatus enum on insert', async () => {
    const { service, stripe } = makeKycService();
    stripe.createResponse = ok({
      id: 'vs_proc',
      status: 'processing',
      clientSecret: null,
      hostedUrl: null,
      verifiedAtSeconds: null,
    });
    const result = await service.startSession({ userId: 'user_2' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.record.status).toBe<KycStatus>('processing');
  });
});

describe('KycService.getLatestForUser', () => {
  it('returns the most-recently-created row for the user', async () => {
    const { service, prisma } = makeKycService();
    const older = await prisma.kycRecord.create({
      data: { userId: 'user_3', provider: 'stripe_identity', externalId: 'vs_older' },
    });
    // Force a stable temporal gap so the orderBy is deterministic.
    older.createdAt = new Date(2026, 0, 1);
    const newer = await prisma.kycRecord.create({
      data: { userId: 'user_3', provider: 'stripe_identity', externalId: 'vs_newer' },
    });
    newer.createdAt = new Date(2026, 5, 1);
    const got = await service.getLatestForUser('user_3');
    expect(got?.externalId).toBe('vs_newer');
  });

  it('returns null when the user has no rows', async () => {
    const { service } = makeKycService();
    expect(await service.getLatestForUser('user_nobody')).toBeNull();
  });

  it('returns null on empty userId without touching Prisma', async () => {
    const { service, prisma } = makeKycService();
    expect(await service.getLatestForUser('')).toBeNull();
    expect(prisma.kycRecord.findFirst).not.toHaveBeenCalled();
  });
});

describe('KycService.applyWebhookEvent', () => {
  const baseEvent = {
    eventId: 'evt_abc',
    eventCreatedSeconds: 1_700_000_000,
    rawPayload: JSON.stringify({ id: 'vs_abc', status: 'verified' }),
  } as const;
  const verifiedSession: StripeIdentitySession = {
    id: 'vs_abc',
    status: 'verified',
    clientSecret: null,
    hostedUrl: null,
    verifiedAtSeconds: 1_700_000_000,
  };

  it('transitions a pending row to verified, encrypts the payload, sets verifiedAt', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_1',
        provider: 'stripe_identity',
        externalId: 'vs_abc',
        status: 'pending',
      },
    });

    const result = await service.applyWebhookEvent({
      ...baseEvent,
      eventType: 'identity.verification_session.verified',
      session: verifiedSession,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe<KycStatus>('verified');
    expect(result.value.lastEventId).toBe('evt_abc');
    expect(result.value.payloadCiphertext).not.toBeNull();
    expect(result.value.payloadKeyVersion).toBe(1);
    expect(result.value.verifiedAt?.toISOString()).toBe(
      new Date(1_700_000_000 * 1000).toISOString(),
    );
  });

  it('idempotent on a redelivered event id (event_replay error)', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_1',
        provider: 'stripe_identity',
        externalId: 'vs_abc',
        status: 'verified',
      },
    });
    // Pretend the row already has the event id stamped.
    prisma.rows[0]!.lastEventId = 'evt_abc';

    const result = await service.applyWebhookEvent({
      ...baseEvent,
      eventType: 'identity.verification_session.verified',
      session: verifiedSession,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('event_replay');
    expect(prisma.kycRecord.update).not.toHaveBeenCalled();
  });

  it('returns session_mismatch when no local row matches the externalId', async () => {
    const { service } = makeKycService();
    const result = await service.applyWebhookEvent({
      ...baseEvent,
      eventType: 'identity.verification_session.verified',
      session: verifiedSession,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('session_mismatch');
  });

  it('preserves the earlier verifiedAt when verified is redelivered', async () => {
    const { service, prisma } = makeKycService();
    const earlier = new Date(1_700_000_000 * 1000);
    await prisma.kycRecord.create({
      data: {
        userId: 'user_1',
        provider: 'stripe_identity',
        externalId: 'vs_abc',
        status: 'verified',
      },
    });
    prisma.rows[0]!.verifiedAt = earlier;
    prisma.rows[0]!.lastEventId = 'evt_prior';

    const result = await service.applyWebhookEvent({
      eventId: 'evt_later',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_800_000_000,
      session: verifiedSession,
      rawPayload: JSON.stringify({ id: 'vs_abc', status: 'verified' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.verifiedAt?.getTime()).toBe(earlier.getTime());
    expect(result.value.lastEventId).toBe('evt_later');
  });

  it('maps requires_input event type → requires_input status', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_1',
        provider: 'stripe_identity',
        externalId: 'vs_abc',
        status: 'processing',
      },
    });
    const result = await service.applyWebhookEvent({
      ...baseEvent,
      eventId: 'evt_input',
      eventType: 'identity.verification_session.requires_input',
      session: { ...verifiedSession, status: 'requires_input' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe<KycStatus>('requires_input');
    expect(result.value.verifiedAt).toBeNull();
  });

  it('maps canceled event type → canceled status without setting verifiedAt', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_1',
        provider: 'stripe_identity',
        externalId: 'vs_abc',
        status: 'pending',
      },
    });
    const result = await service.applyWebhookEvent({
      ...baseEvent,
      eventId: 'evt_cancel',
      eventType: 'identity.verification_session.canceled',
      session: { ...verifiedSession, status: 'canceled' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe<KycStatus>('canceled');
    expect(result.value.verifiedAt).toBeNull();
  });

  it('rejects empty eventId / session.id with invalid_request', async () => {
    const { service } = makeKycService();
    const r1 = await service.applyWebhookEvent({
      ...baseEvent,
      eventId: '',
      eventType: 'identity.verification_session.verified',
      session: verifiedSession,
    });
    expect(r1.ok).toBe(false);
    if (r1.ok) return;
    expect(r1.error.reason).toBe('invalid_request');

    const r2 = await service.applyWebhookEvent({
      ...baseEvent,
      eventType: 'identity.verification_session.verified',
      session: { ...verifiedSession, id: '' },
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.reason).toBe('invalid_request');
  });
});

describe('normalizeKycEventTypeLabel', () => {
  it('maps known identity.verification_session.* types to their short suffix', () => {
    expect(normalizeKycEventTypeLabel('identity.verification_session.verified')).toBe('verified');
    expect(normalizeKycEventTypeLabel('identity.verification_session.processing')).toBe(
      'processing',
    );
    expect(normalizeKycEventTypeLabel('identity.verification_session.requires_input')).toBe(
      'requires_input',
    );
    expect(normalizeKycEventTypeLabel('identity.verification_session.canceled')).toBe('canceled');
    expect(normalizeKycEventTypeLabel('identity.verification_session.created')).toBe('created');
    expect(normalizeKycEventTypeLabel('identity.verification_session.redacted')).toBe('redacted');
  });

  it('collapses unknown / empty types to "other" so cardinality stays bounded', () => {
    expect(normalizeKycEventTypeLabel('customer.subscription.created')).toBe('other');
    expect(normalizeKycEventTypeLabel('')).toBe('other');
    expect(normalizeKycEventTypeLabel('identity.verification_session.someFutureType')).toBe(
      'other',
    );
  });
});

/**
 * Observability metrics (TS-026-followup-7; CLAUDE.md §10). Mirrors the
 * `IpCircuitBreakerService` metrics-test shape: init a real MeterProvider,
 * drive the service, then assert the Prometheus text exposition. The
 * service must be constructed AFTER `initMetrics` so its `KycMetrics`
 * instruments bind to the live meter rather than the no-op fallback — so
 * `makeKycService()` is called inside each test, not before init.
 */
describe('KycService — observability metrics (TS-026-followup-7)', () => {
  beforeEach(() => {
    initMetrics({
      service: 'service-identity-test',
      env: 'test',
      // Far-future sweep so the periodic reader never races the test;
      // serializeMetrics() forces a synchronous collect on each scrape.
      exportIntervalMillis: 3_600_000,
    });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  it('counts a successful startSession with outcome="ok"', async () => {
    const { service } = makeKycService();
    const result = await service.startSession({ userId: 'user_metrics_1' });
    expect(result.ok).toBe(true);

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_sessions_created_total\{[^}]*outcome="ok"[^}]*\} 1/);
  });

  it('counts a Stripe failure with outcome="stripe_unavailable"', async () => {
    const { service, stripe } = makeKycService();
    stripe.createResponse = err({ reason: 'stripe_unavailable', cause: new Error('boom') });
    await service.startSession({ userId: 'user_metrics_2' });

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_sessions_created_total\{[^}]*outcome="stripe_unavailable"[^}]*\} 1/);
  });

  it('counts an empty-userId start with outcome="invalid_request"', async () => {
    const { service } = makeKycService();
    await service.startSession({ userId: '' });

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_sessions_created_total\{[^}]*outcome="invalid_request"[^}]*\} 1/);
  });

  it('counts an applied webhook event with the event_type + outcome labels', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_metrics_3',
        provider: 'stripe_identity',
        externalId: 'vs_metrics_applied',
        status: 'pending',
      },
    });
    await service.applyWebhookEvent({
      eventId: 'evt_metrics_applied',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_700_000_000,
      session: {
        id: 'vs_metrics_applied',
        status: 'verified',
        clientSecret: null,
        hostedUrl: null,
        verifiedAtSeconds: 1_700_000_000,
      },
      rawPayload: JSON.stringify({ id: 'vs_metrics_applied', status: 'verified' }),
    });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /kyc_webhook_applied_total\{[^}]*event_type="verified"[^}]*outcome="applied"[^}]*\} 1/,
    );
    // Latency histogram materialises a count sample bucketed by outcome.
    expect(out).toMatch(
      /kyc_webhook_apply_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/,
    );
  });

  it('counts a session_mismatch webhook with outcome="session_mismatch"', async () => {
    const { service } = makeKycService();
    await service.applyWebhookEvent({
      eventId: 'evt_metrics_miss',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_700_000_000,
      session: {
        id: 'vs_no_local_row',
        status: 'verified',
        clientSecret: null,
        hostedUrl: null,
        verifiedAtSeconds: 1_700_000_000,
      },
      rawPayload: JSON.stringify({ id: 'vs_no_local_row', status: 'verified' }),
    });

    const out = await serializeMetrics();
    expect(out).toMatch(/kyc_webhook_applied_total\{[^}]*outcome="session_mismatch"[^}]*\} 1/);
  });

  it('never leaks a userId / session id / payload onto the scrape surface', async () => {
    const { service, prisma } = makeKycService();
    await prisma.kycRecord.create({
      data: {
        userId: 'user_pii_check',
        provider: 'stripe_identity',
        externalId: 'vs_pii_check',
        status: 'pending',
      },
    });
    await service.startSession({ userId: 'user_pii_check' });
    await service.applyWebhookEvent({
      eventId: 'evt_pii_check',
      eventType: 'identity.verification_session.verified',
      eventCreatedSeconds: 1_700_000_000,
      session: {
        id: 'vs_pii_check',
        status: 'verified',
        clientSecret: null,
        hostedUrl: null,
        verifiedAtSeconds: 1_700_000_000,
      },
      rawPayload: JSON.stringify({ id: 'vs_pii_check', secret: 'should-never-appear' }),
    });

    const out = await serializeMetrics();
    expect(out).not.toContain('user_pii_check');
    expect(out).not.toContain('vs_pii_check');
    expect(out).not.toContain('evt_pii_check');
    expect(out).not.toContain('should-never-appear');
    // …but the metrics themselves are present.
    expect(out).toMatch(/kyc_sessions_created_total/);
    expect(out).toMatch(/kyc_webhook_applied_total/);
  });
});
