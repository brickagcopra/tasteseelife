import { randomBytes } from 'node:crypto';

import { initMetrics, serializeMetrics, shutdownMetrics } from '@taste-and-see/tracing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import type { AdverseFindingEmitter } from './adverse-finding-emitter';
import { ApplicationsMetrics } from './applications-metrics';
import { BackgroundCheckPayloadCipherService } from './background-check-payload-cipher.service';
import {
  BackgroundCheckService,
  type BackgroundCheckRecord,
  type BackgroundCheckRecordStatus,
} from './background-check.service';
import { CheckrClient, type CheckrFailure } from './checkr.client';
import { err, ok, type Result } from './result';

type FakeRow = {
  id: string;
  providerId: string;
  applicationId: string | null;
  status: BackgroundCheckRecordStatus;
  checkrCandidateId: string;
  checkrReportId: string | null;
  lastEventId: string | null;
  completedAt: Date | null;
  payloadCiphertext: Buffer | null;
  payloadIv: Buffer | null;
  payloadAuthTag: Buffer | null;
  payloadKeyVersion: number | null;
  createdAt: Date;
  updatedAt: Date;
};

class FakePrisma {
  public rows: FakeRow[] = [];
  private idCounter = 0;

  providerBackgroundCheck = {
    create: vi.fn(async (args: { data: Partial<FakeRow> }): Promise<FakeRow> => {
      this.idCounter += 1;
      const now = new Date();
      const row: FakeRow = {
        id: `bg_${this.idCounter}`,
        providerId: args.data.providerId ?? '',
        applicationId: args.data.applicationId ?? null,
        status: args.data.status ?? 'pending',
        checkrCandidateId: args.data.checkrCandidateId ?? '',
        checkrReportId: args.data.checkrReportId ?? null,
        lastEventId: null,
        completedAt: null,
        payloadCiphertext: null,
        payloadIv: null,
        payloadAuthTag: null,
        payloadKeyVersion: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(row);
      return row;
    }),
    findFirst: vi.fn(
      async (args: {
        where: { providerId: string };
        orderBy?: { createdAt: 'asc' | 'desc' };
      }): Promise<FakeRow | null> => {
        const matches = this.rows.filter((r) => r.providerId === args.where.providerId);
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
    findUnique: vi.fn(
      async (args: { where: { checkrReportId: string } }): Promise<FakeRow | null> => {
        return this.rows.find((r) => r.checkrReportId === args.where.checkrReportId) ?? null;
      },
    ),
    update: vi.fn(
      async (args: { where: { id: string }; data: Partial<FakeRow> }): Promise<FakeRow> => {
        const row = this.rows.find((r) => r.id === args.where.id);
        if (!row) throw new Error(`row not found: ${args.where.id}`);
        Object.assign(row, args.data, { updatedAt: new Date() });
        return row;
      },
    ),
  };

  /**
   * TS-307a — the provider row the adverse-finding screen reads.
   * `null` models a check whose provider row has vanished.
   */
  public providerRow: { readonly id: string; readonly status: string } | null = {
    id: 'prov_1',
    status: 'active',
  };

  provider = {
    findUnique: vi.fn(
      async (args: { where: { id: string } }): Promise<{ readonly status: string } | null> => {
        if (this.providerRow === null || this.providerRow.id !== args.where.id) return null;
        return { status: this.providerRow.status };
      },
    ),
  };

  /** Runs the callback against this same fake — no isolation modelled. */
  async $transaction<T>(callback: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

/** Captures what the webhook path asked the emitter to raise (TS-307a). */
class FakeAdverseFindingEmitter {
  public calls: Array<Record<string, unknown>> = [];

  async emitAdverseFinding(_executor: unknown, input: Record<string, unknown>): Promise<boolean> {
    this.calls.push(input);
    return true;
  }
}

class FakeCheckrClient {
  candidateResponses: Array<Result<{ id: string }, CheckrFailure>> = [];
  reportResponses: Array<Result<{ id: string; status: string }, CheckrFailure>> = [];
  createCandidateCalls: Array<Record<string, unknown>> = [];
  createReportCalls: Array<Record<string, unknown>> = [];

  async createCandidate(input: Record<string, unknown>) {
    this.createCandidateCalls.push(input);
    return this.candidateResponses.shift() ?? ok({ id: 'cand_default' });
  }

  async createReport(input: Record<string, unknown>) {
    this.createReportCalls.push(input);
    return this.reportResponses.shift() ?? ok({ id: 'rep_default', status: 'pending' });
  }
}

const ENC_KEY = randomBytes(32);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY: ENC_KEY.toString('base64'),
    BACKGROUND_CHECK_PAYLOAD_ENC_KEY_VERSION: 1,
    CHECKR_DEFAULT_PACKAGE: 'tasker_standard',
    CHECKR_DEFAULT_WORK_LOCATION_STATES: 'NY,NJ',
    ...overrides,
  } as unknown as Env;
}

function makeService(): {
  prisma: FakePrisma;
  checkr: FakeCheckrClient;
  adverse: FakeAdverseFindingEmitter;
  service: BackgroundCheckService;
} {
  const prisma = new FakePrisma();
  const checkr = new FakeCheckrClient();
  const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
  const adverse = new FakeAdverseFindingEmitter();
  const service = new BackgroundCheckService(
    prisma as unknown as PrismaService,
    checkr as unknown as CheckrClient,
    cipher,
    adverse as unknown as AdverseFindingEmitter,
    makeEnv(),
  );
  return { prisma, checkr, adverse, service };
}

const APPLICANT = {
  firstName: 'Sam',
  lastName: 'Cook',
  email: 'sam@example.com',
  phone: '+15551234567',
  dob: '1980-05-12',
  zipcode: '10021',
};

describe('BackgroundCheckService.startCheck', () => {
  it('persists a pending row + returns ok when Checkr accepts both calls', async () => {
    const { service, prisma, checkr } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'pending' }));

    const result = await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(true);
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]?.providerId).toBe('prov_1');
    expect(prisma.rows[0]?.applicationId).toBe('app_1');
    expect(prisma.rows[0]?.checkrCandidateId).toBe('cand_abc');
    expect(prisma.rows[0]?.checkrReportId).toBe('rep_abc');
    expect(prisma.rows[0]?.status).toBe('pending');
  });

  it('maps Checkr `clear` status string to local `clear`', async () => {
    const { service, checkr, prisma } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'clear' }));

    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(prisma.rows[0]?.status).toBe('clear');
  });

  it('forwards the idempotencyKey to both Checkr calls', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'pending' }));

    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
      idempotencyKey: 'top-level-key',
    });
    expect(checkr.createCandidateCalls[0]?.['idempotencyKey']).toBe(
      'checkr-candidate:top-level-key',
    );
    expect(checkr.createReportCalls[0]?.['idempotencyKey']).toBe('checkr-report:top-level-key');
  });

  it('passes the configured package + work locations to createReport', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'pending' }));

    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(checkr.createReportCalls[0]?.['packageSlug']).toBe('tasker_standard');
    expect(checkr.createReportCalls[0]?.['workLocationStates']).toEqual(['NY', 'NJ']);
  });

  it('returns invalid_request when providerId is empty', async () => {
    const { service } = makeService();
    const result = await service.startCheck({
      providerId: '',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('translates Checkr.unavailable failure into checkr_unavailable', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(err({ reason: 'checkr_unavailable', cause: new Error('x') }));

    const result = await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('checkr_unavailable');
    }
  });

  it('translates Checkr.invalid_request failure into checkr_invalid_applicant', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(err({ reason: 'invalid_request', message: 'bad dob' }));

    const result = await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('checkr_invalid_applicant');
    }
  });

  it('does not call createReport when createCandidate fails', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(err({ reason: 'checkr_unavailable', cause: new Error('x') }));

    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    expect(checkr.createReportCalls).toHaveLength(0);
  });
});

describe('BackgroundCheckService.getLatestForProvider', () => {
  it('returns null for an empty providerId', async () => {
    const { service } = makeService();
    expect(await service.getLatestForProvider('')).toBeNull();
  });

  it('returns the most-recent row for the provider', async () => {
    const { service, checkr } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_a' }), ok({ id: 'cand_b' }));
    checkr.reportResponses.push(
      ok({ id: 'rep_a', status: 'pending' }),
      ok({ id: 'rep_b', status: 'clear' }),
    );
    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    // Bump time so the second row sorts strictly after.
    await new Promise((resolve) => setTimeout(resolve, 2));
    await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_2',
      applicant: APPLICANT,
    });

    const latest = await service.getLatestForProvider('prov_1');
    expect(latest?.checkrReportId).toBe('rep_b');
  });
});

describe('BackgroundCheckService.applyWebhookEvent', () => {
  async function seedRow(): Promise<{
    prisma: FakePrisma;
    service: BackgroundCheckService;
    row: BackgroundCheckRecord;
  }> {
    const { service, prisma, checkr } = makeService();
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'processing' }));
    const result = await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    if (!result.ok) throw new Error('seed failed');
    return { prisma, service, row: result.value };
  }

  it('returns invalid_request when eventId is empty', async () => {
    const { service } = await seedRow();
    const result = await service.applyWebhookEvent({
      eventId: '',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('invalid_request');
    }
  });

  it('returns report_mismatch when no local row matches the report id', async () => {
    const { service } = await seedRow();
    const result = await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_nope', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('report_mismatch');
    }
  });

  it('updates status + encrypts payload + sets completedAt on the transition into `clear`', async () => {
    const { service, prisma } = await seedRow();
    const result = await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{"foo":"bar"}',
    });
    expect(result.ok).toBe(true);
    const row = prisma.rows[0];
    expect(row?.status).toBe('clear');
    expect(row?.lastEventId).toBe('evt_1');
    expect(row?.completedAt).toEqual(new Date(1_700_000_000 * 1000));
    expect(row?.payloadCiphertext).not.toBeNull();
    expect(row?.payloadIv).not.toBeNull();
    expect(row?.payloadAuthTag).not.toBeNull();
    expect(row?.payloadKeyVersion).toBe(1);
  });

  it('returns event_replay when the same event id is presented twice', async () => {
    const { service } = await seedRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    const replay = await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    expect(replay.ok).toBe(false);
    if (!replay.ok) {
      expect(replay.error.reason).toBe('event_replay');
    }
  });

  it('preserves an earlier completedAt on a redelivered terminal event', async () => {
    const { service, prisma } = await seedRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    const firstCompletedAt = prisma.rows[0]?.completedAt;
    // Different event id (not a replay) but same terminal state.
    await service.applyWebhookEvent({
      eventId: 'evt_2',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_800_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });
    expect(prisma.rows[0]?.completedAt).toEqual(firstCompletedAt);
  });

  it('maps Checkr `expired` status string to local `failed`', async () => {
    const { service, prisma } = await seedRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.expired',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'expired' },
      rawPayload: '{}',
    });
    expect(prisma.rows[0]?.status).toBe('failed');
  });

  it('treats an unknown Checkr status string as `failed`', async () => {
    const { service, prisma } = await seedRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.weird',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'not_a_real_status' },
      rawPayload: '{}',
    });
    expect(prisma.rows[0]?.status).toBe('failed');
  });
});

/**
 * applyWebhookEvent observability (TS-051-followup-7). A real MeterProvider is
 * booted so the `ApplicationsMetrics` passed here binds live; the service
 * drives each apply outcome end-to-end and the exposition is asserted.
 */
describe('BackgroundCheckService.applyWebhookEvent — observability', () => {
  beforeEach(() => {
    initMetrics({ service: 'service-provider-test', env: 'test', exportIntervalMillis: 3_600_000 });
  });

  afterEach(async () => {
    await shutdownMetrics();
  });

  async function seedMeteredRow(): Promise<{
    prisma: FakePrisma;
    service: BackgroundCheckService;
  }> {
    const prisma = new FakePrisma();
    const checkr = new FakeCheckrClient();
    const cipher = new BackgroundCheckPayloadCipherService(makeEnv());
    const service = new BackgroundCheckService(
      prisma as unknown as PrismaService,
      checkr as unknown as CheckrClient,
      cipher,
      new FakeAdverseFindingEmitter() as unknown as AdverseFindingEmitter,
      makeEnv(),
      new ApplicationsMetrics(),
    );
    checkr.candidateResponses.push(ok({ id: 'cand_abc' }));
    checkr.reportResponses.push(ok({ id: 'rep_abc', status: 'processing' }));
    const result = await service.startCheck({
      providerId: 'prov_1',
      applicationId: 'app_1',
      applicant: APPLICANT,
    });
    if (!result.ok) throw new Error('seed failed');
    return { prisma, service };
  }

  it('counts outcome="applied" with event_type + a latency sample on a real apply', async () => {
    const { service } = await seedMeteredRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{"foo":"bar"}',
    });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_background_check_webhook_applied_total\{[^}]*event_type="completed"[^}]*outcome="applied"[^}]*\} 1/,
    );
    expect(out).toMatch(
      /provider_background_check_webhook_apply_duration_seconds_count\{[^}]*outcome="applied"[^}]*\} 1/,
    );
  });

  it('counts outcome="report_mismatch" when no local row matches', async () => {
    const { service } = await seedMeteredRow();
    await service.applyWebhookEvent({
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_nope', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    });

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_background_check_webhook_applied_total\{[^}]*outcome="report_mismatch"[^}]*\} 1/,
    );
  });

  it('counts outcome="replayed" on a duplicate event id', async () => {
    const { service } = await seedMeteredRow();
    const apply = {
      eventId: 'evt_1',
      eventType: 'report.completed',
      eventCreatedSeconds: 1_700_000_000,
      report: { id: 'rep_abc', candidateId: 'cand_abc', status: 'clear' },
      rawPayload: '{}',
    };
    await service.applyWebhookEvent(apply);
    await service.applyWebhookEvent(apply);

    const out = await serializeMetrics();
    expect(out).toMatch(
      /provider_background_check_webhook_applied_total\{[^}]*outcome="replayed"[^}]*\} 1/,
    );
  });
});
