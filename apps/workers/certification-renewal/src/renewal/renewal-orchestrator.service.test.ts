import type { CertificationRenewalCandidate, RecipientContact } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env';

import type { DispatchClient } from './clients/dispatch.client';
import type { ExpireClient } from './clients/expire.client';
import type { RecipientContactsClient } from './clients/recipient-contacts.client';
import type { RenewalsClient } from './clients/renewals.client';
import { RenewalOrchestratorService } from './renewal-orchestrator.service';

const DAY = 86_400_000;
const NOW = new Date('2026-06-08T14:00:00.000Z');
const PERIOD = { periodKey: '2026-06-08' };

function isoDaysFromNow(days: number): string {
  return new Date(NOW.getTime() + days * DAY).toISOString();
}

function candidate(
  overrides: Partial<CertificationRenewalCandidate> = {},
): CertificationRenewalCandidate {
  return {
    certificationId: 'cert_1',
    studentUserId: 'student_1',
    holderName: 'Jane Holder',
    courseId: 'course_1',
    courseTitle: 'Dementia-Sensitive Dining',
    track: 'dementia_sensitive',
    issuedAt: '2024-06-08T12:00:00.000Z',
    expiresAt: isoDaysFromNow(45), // milestone 60
    ...overrides,
  };
}

function activeContact(userId: string): RecipientContact {
  return { userId, email: `${userId}@example.com`, status: 'active' };
}

function makeEnv(): Env {
  return {
    CERTIFICATION_RENEWAL_PAGE_LIMIT: 100,
    CERTIFICATION_RENEWAL_HORIZON_DAYS: 90,
    CERTIFICATION_RENEWAL_RENEW_URL: 'https://academy.example.com/renewals',
    CERTIFICATION_RENEWAL_APP_NAME: 'Taste & See',
  } as unknown as Env;
}

interface Fakes {
  renewals: { fetchPage: ReturnType<typeof vi.fn> };
  contacts: { resolve: ReturnType<typeof vi.fn> };
  expireClient: { expire: ReturnType<typeof vi.fn> };
  dispatch: { dispatch: ReturnType<typeof vi.fn> };
}

function buildOrchestrator(fakes: Partial<Fakes> = {}): {
  orchestrator: RenewalOrchestratorService;
  fakes: Fakes;
} {
  const f: Fakes = {
    renewals: fakes.renewals ?? {
      fetchPage: vi.fn(async () => ({ certifications: [], nextCursor: null })),
    },
    contacts: fakes.contacts ?? {
      resolve: vi.fn(async () => new Map<string, RecipientContact>()),
    },
    expireClient: fakes.expireClient ?? {
      expire: vi.fn(async () => ({ certificationId: 'cert_1', status: 'expired', changed: true })),
    },
    dispatch: fakes.dispatch ?? {
      dispatch: vi.fn(async () => ({ replayed: false, status: 'sent' })),
    },
  };
  const orchestrator = new RenewalOrchestratorService(
    makeEnv(),
    f.renewals as unknown as RenewalsClient,
    f.contacts as unknown as RecipientContactsClient,
    f.expireClient as unknown as ExpireClient,
    f.dispatch as unknown as DispatchClient,
    () => NOW,
  );
  return { orchestrator, fakes: f };
}

describe('RenewalOrchestratorService.runForPeriod', () => {
  it('expires a lapsed certification and dispatches a reminder for a milestone candidate', async () => {
    const lapsed = candidate({ certificationId: 'cert_lapsed', expiresAt: isoDaysFromNow(-2) });
    const reminder = candidate({ certificationId: 'cert_rem', studentUserId: 'student_rem' });
    const { orchestrator, fakes } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => ({ certifications: [lapsed, reminder], nextCursor: null })),
      },
      contacts: {
        resolve: vi.fn(async () => new Map([['student_rem', activeContact('student_rem')]])),
      },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(fakes.expireClient.expire).toHaveBeenCalledWith('cert_lapsed');
    expect(fakes.contacts.resolve).toHaveBeenCalledWith(['student_rem']);
    expect(fakes.dispatch.dispatch).toHaveBeenCalledOnce();
    expect(report).toMatchObject({
      candidatesScanned: 2,
      certificationsExpired: 1,
      remindersSent: 1,
    });
  });

  it('walks the cursor across multiple pages', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({
        certifications: [candidate({ certificationId: 'c1' })],
        nextCursor: 'c1',
      })
      .mockResolvedValueOnce({
        certifications: [candidate({ certificationId: 'c2' })],
        nextCursor: null,
      });
    const { orchestrator, fakes } = buildOrchestrator({
      renewals: { fetchPage },
      contacts: {
        resolve: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, activeContact(id)]))),
      },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]?.[0]).toBe('c1'); // second call passes the cursor
    expect(report.candidatesScanned).toBe(2);
    expect(report.remindersSent).toBe(2);
    expect(fakes.dispatch.dispatch).toHaveBeenCalledTimes(2);
  });

  it('skips a reminder when the recipient is unknown or not active', async () => {
    const reminder = candidate({ certificationId: 'cert_rem', studentUserId: 'student_rem' });
    const { orchestrator, fakes } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => ({ certifications: [reminder], nextCursor: null })),
      },
      contacts: {
        resolve: vi.fn(
          async () =>
            new Map([
              [
                'student_rem',
                { userId: 'student_rem', email: 's@example.com', status: 'suspended' },
              ],
            ]),
        ),
      },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(fakes.dispatch.dispatch).not.toHaveBeenCalled();
    expect(report.recipientsSkipped).toBe(1);
    expect(report.remindersSent).toBe(0);
  });

  it('counts a no-op expire and a failed expire separately', async () => {
    const lapsedA = candidate({ certificationId: 'cert_a', expiresAt: isoDaysFromNow(-1) });
    const lapsedB = candidate({ certificationId: 'cert_b', expiresAt: isoDaysFromNow(-1) });
    const expire = vi
      .fn()
      .mockResolvedValueOnce({ certificationId: 'cert_a', status: 'expired', changed: false })
      .mockRejectedValueOnce(new Error('boom'));
    const { orchestrator } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => ({ certifications: [lapsedA, lapsedB], nextCursor: null })),
      },
      expireClient: { expire },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.expireNoOp).toBe(1);
    expect(report.expireFailed).toBe(1);
    expect(report.certificationsExpired).toBe(0);
  });

  it('counts a replayed dispatch + a suppressed dispatch + a failed dispatch', async () => {
    const c1 = candidate({ certificationId: 'c1', studentUserId: 's1' });
    const c2 = candidate({ certificationId: 'c2', studentUserId: 's2' });
    const c3 = candidate({ certificationId: 'c3', studentUserId: 's3' });
    const dispatch = vi
      .fn()
      .mockResolvedValueOnce({ replayed: true, status: 'sent' })
      .mockResolvedValueOnce({ replayed: false, status: 'suppressed_by_preference' })
      .mockRejectedValueOnce(new Error('down'));
    const { orchestrator } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => ({ certifications: [c1, c2, c3], nextCursor: null })),
      },
      contacts: {
        resolve: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, activeContact(id)]))),
      },
      dispatch: { dispatch },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.remindersReplayed).toBe(1);
    expect(report.remindersSuppressed).toBe(1);
    expect(report.remindersFailed).toBe(1);
  });

  it('skips the page reminders when contact resolution fails (lapses still recorded)', async () => {
    const lapsed = candidate({ certificationId: 'cert_lapsed', expiresAt: isoDaysFromNow(-1) });
    const reminder = candidate({ certificationId: 'cert_rem', studentUserId: 'student_rem' });
    const { orchestrator, fakes } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => ({ certifications: [lapsed, reminder], nextCursor: null })),
      },
      contacts: {
        resolve: vi.fn(async () => {
          throw new Error('identity down');
        }),
      },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.certificationsExpired).toBe(1); // lapse recorded before the contact hop
    expect(report.recipientsSkipped).toBe(1);
    expect(fakes.dispatch.dispatch).not.toHaveBeenCalled();
  });

  it('aborts the walk when a page fetch fails, returning the partial report', async () => {
    const { orchestrator } = buildOrchestrator({
      renewals: {
        fetchPage: vi.fn(async () => {
          throw new Error('academy down');
        }),
      },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.candidatesScanned).toBe(0);
  });

  it('skips a between-milestones candidate without dispatching', async () => {
    // ~50 days out → between the 30 and 60 milestones? No: 50 maps to 60.
    // Use 100 days (beyond the 90-day window) for a genuine skip.
    const far = candidate({ certificationId: 'cert_far', expiresAt: isoDaysFromNow(100) });
    const { orchestrator, fakes } = buildOrchestrator({
      renewals: { fetchPage: vi.fn(async () => ({ certifications: [far], nextCursor: null })) },
    });

    const report = await orchestrator.runForPeriod(PERIOD);

    expect(report.skipped).toBe(1);
    expect(fakes.contacts.resolve).not.toHaveBeenCalled();
    expect(fakes.dispatch.dispatch).not.toHaveBeenCalled();
  });
});
