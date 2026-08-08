import { describe, expect, it } from 'vitest';

import type {
  AuditActorContext,
  AuditEmitter,
  AuditMutationDescriptor,
} from '@taste-and-see/nest-audit';
import type { PrismaService } from '../../../prisma/prisma.service';
import { MandatedReporterRepository } from '../repositories/mandated-reporter.repository';
import { FakeMandatedReporterPrisma } from './__fixtures__/fake-prisma';
import { MandatedReporterService } from './mandated-reporter.service';

/**
 * Unit tests for the mandated-reporter pathway (TS-303a).
 *
 * Three invariants dominate, and each has a failure mode worse than the
 * friction it adds: never auto-close, no filing prep against an unverified
 * jurisdiction, and four eyes on the signoff. DB CHECK constraints backstop
 * the last two; these tests cover the service layer, where the errors are
 * legible to an operator.
 */

const OPENED_AT = new Date('2026-07-24T12:00:00.000Z');
const OPERATOR = 'user_ops_1';
const REVIEWER = 'user_ops_2';

/** Minimal audit actor — the controller builds the real one from the token. */
const AUDIT: AuditActorContext = {
  actorUserId: OPERATOR,
  actorRole: 'trust_safety_operator',
  actorTenantScopeType: 'global',
  actorTenantScopeId: null,
  ip: '203.0.113.7',
  userAgent: 'ops-console/1.0',
  requestId: 'req_1',
  traceId: null,
};

/** Records what was emitted so tests can assert the audit trail's shape. */
class FakeAuditEmitter {
  readonly emitted: AuditMutationDescriptor[] = [];
  shouldFail = false;

  emit = async (
    _tx: unknown,
    _actor: AuditActorContext,
    descriptor: AuditMutationDescriptor,
  ): Promise<void> => {
    if (this.shouldFail) throw new Error('audit append rejected');
    this.emitted.push(descriptor);
  };
}

function build(seed: {
  readonly stateCode?: string;
  readonly verified?: boolean;
  readonly statutoryDeadlineHours?: number | null;
}): {
  service: MandatedReporterService;
  prisma: FakeMandatedReporterPrisma;
  audit: FakeAuditEmitter;
} {
  const prisma = new FakeMandatedReporterPrisma();
  prisma.seedJurisdiction({
    stateCode: seed.stateCode ?? 'NY',
    verified: seed.verified ?? false,
    statutoryDeadlineHours: seed.statutoryDeadlineHours ?? null,
  });
  const repository = new MandatedReporterRepository(prisma as unknown as PrismaService);
  const audit = new FakeAuditEmitter();
  return {
    service: new MandatedReporterService(repository, audit as unknown as AuditEmitter),
    prisma,
    audit,
  };
}

async function openScreeningCase(
  service: MandatedReporterService,
  incidentId = 'inc_1',
): Promise<string> {
  const opened = await service.openCase(
    { incidentId, stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
    OPENED_AT,
  );
  return opened.id;
}

describe('MandatedReporterService.openCase', () => {
  it('opens a case in screening against an existing jurisdiction', async () => {
    const { service } = build({});

    const opened = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );

    expect(opened.status).toBe('screening');
    expect(opened.incidentId).toBe('inc_1');
    expect(opened.stateCode).toBe('NY');
    expect(opened.openedByUserId).toBe(OPERATOR);
    expect(opened.openedAt).toEqual(OPENED_AT);
  });

  it('opens even when the jurisdiction is unverified — our compliance backlog must not stop the clock', async () => {
    const { service } = build({ verified: false });

    const opened = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );

    expect(opened.status).toBe('screening');
  });

  it('stamps the statutory deadline from the jurisdiction window', async () => {
    const { service } = build({ statutoryDeadlineHours: 24 });

    const opened = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );

    expect(opened.statutoryDueAt).toEqual(new Date('2026-07-25T12:00:00.000Z'));
  });

  it('leaves the deadline NULL when the state window is unknown, rather than defaulting one', async () => {
    const { service } = build({ statutoryDeadlineHours: null });

    const opened = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );

    expect(opened.statutoryDueAt).toBeNull();
  });

  it('is idempotent — a retry returns the existing case, not a second statutory clock', async () => {
    const { service, prisma } = build({});

    const first = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );
    const second = await service.openCase(
      { incidentId: 'inc_1', stateCode: 'NY', openedByUserId: REVIEWER, audit: AUDIT },
      new Date('2026-07-24T18:00:00.000Z'),
    );

    expect(second.id).toBe(first.id);
    expect(second.openedByUserId).toBe(OPERATOR);
    expect(prisma.cases).toHaveLength(1);
  });

  it('normalises a lowercase state code', async () => {
    const { service } = build({ stateCode: 'NY' });

    const opened = await service.openCase(
      { incidentId: 'inc_1', stateCode: ' ny ', openedByUserId: OPERATOR, audit: AUDIT },
      OPENED_AT,
    );

    expect(opened.stateCode).toBe('NY');
  });

  it('rejects a code that is not a US state or territory', async () => {
    const { service } = build({});

    await expect(
      service.openCase({
        incidentId: 'inc_1',
        stateCode: 'XX',
        openedByUserId: OPERATOR,
        audit: AUDIT,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404s when no jurisdiction kit row exists for the state', async () => {
    const { service } = build({ stateCode: 'NY' });

    await expect(
      service.openCase({
        incidentId: 'inc_1',
        stateCode: 'CA',
        openedByUserId: OPERATOR,
        audit: AUDIT,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('MandatedReporterService.advance', () => {
  it('rejects an illegal transition', async () => {
    const { service } = build({});
    const caseId = await openScreeningCase(service);

    await expect(
      service.advance({
        caseId,
        to: 'filed',
        actorUserId: OPERATOR,
        filingReference: 'ref',
        audit: AUDIT,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('blocks filing prep against an unverified jurisdiction', async () => {
    const { service } = build({ verified: false });
    const caseId = await openScreeningCase(service);

    await expect(
      service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('allows filing prep once compliance has verified the jurisdiction', async () => {
    const { service } = build({ verified: true });
    const caseId = await openScreeningCase(service);

    const advanced = await service.advance({
      caseId,
      to: 'filing_prep',
      actorUserId: OPERATOR,
      audit: AUDIT,
    });

    expect(advanced.status).toBe('filing_prep');
  });

  it('lets a case be assessed not-reportable without a verified jurisdiction', async () => {
    // Deciding NOT to file needs no agency details, so the verification gate
    // must not strand an operator who has assessed the facts.
    const { service } = build({ verified: false });
    const caseId = await openScreeningCase(service);

    const advanced = await service.advance({
      caseId,
      to: 'not_reportable',
      actorUserId: OPERATOR,
      audit: AUDIT,
      determinationNotes: 'assessed; no reportable conduct',
    });

    expect(advanced.status).toBe('not_reportable');
    expect(advanced.determinationNotes).toBe('assessed; no reportable conduct');
  });

  it('requires a filing reference when recording a filing', async () => {
    const { service } = build({ verified: true });
    const caseId = await openScreeningCase(service);
    await service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT });

    await expect(
      service.advance({ caseId, to: 'filed', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.advance({
        caseId,
        to: 'filed',
        actorUserId: OPERATOR,
        filingReference: '   ',
        audit: AUDIT,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('stamps filedAt + reference on the filing transition', async () => {
    const { service } = build({ verified: true });
    const caseId = await openScreeningCase(service);
    await service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT });

    const filedAt = new Date('2026-07-24T15:00:00.000Z');
    const filed = await service.advance(
      {
        caseId,
        to: 'filed',
        actorUserId: OPERATOR,
        filingReference: 'APS-2026-0001',
        audit: AUDIT,
      },
      filedAt,
    );

    expect(filed.status).toBe('filed');
    expect(filed.filedAt).toEqual(filedAt);
    expect(filed.filingReference).toBe('APS-2026-0001');
  });

  it('refuses a signoff by the operator who opened the case (four eyes)', async () => {
    const { service } = build({});
    const caseId = await openScreeningCase(service);
    await service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT });

    await expect(
      service.advance({ caseId, to: 'signed_off', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records the reviewer on a valid signoff', async () => {
    const { service } = build({});
    const caseId = await openScreeningCase(service);
    await service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT });

    const reviewedAt = new Date('2026-07-25T09:00:00.000Z');
    const signedOff = await service.advance(
      { caseId, to: 'signed_off', actorUserId: REVIEWER, reviewerNotes: 'concur', audit: AUDIT },
      reviewedAt,
    );

    expect(signedOff.status).toBe('signed_off');
    expect(signedOff.reviewerUserId).toBe(REVIEWER);
    expect(signedOff.reviewedAt).toEqual(reviewedAt);
    expect(signedOff.reviewerNotes).toBe('concur');
  });

  it('surfaces a lost compare-and-swap race as a conflict', async () => {
    const { service, prisma } = build({});
    const caseId = await openScreeningCase(service);
    // Another operator moved the case between this caller's read and write.
    const row = prisma.cases.find((c) => c['id'] === caseId);
    const originalUpdateMany = prisma.mandatedReporterCase.updateMany;
    Object.defineProperty(prisma.mandatedReporterCase, 'updateMany', {
      value: async (args: {
        where: { id: string; status: string };
        data: Record<string, unknown>;
      }) => {
        if (row !== undefined) row['status'] = 'filing_prep';
        return originalUpdateMany(args);
      },
    });

    await expect(
      service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('404s on an unknown case', async () => {
    const { service } = build({});

    await expect(
      service.advance({
        caseId: 'mrc_missing',
        to: 'not_reportable',
        actorUserId: OPERATOR,
        audit: AUDIT,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to move a signed-off case (terminal)', async () => {
    const { service } = build({});
    const caseId = await openScreeningCase(service);
    await service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT });
    await service.advance({ caseId, to: 'signed_off', actorUserId: REVIEWER, audit: AUDIT });

    await expect(
      service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('MandatedReporterService.assertIncidentResolvable — the never-auto-close gate', () => {
  it('is a no-op for an incident never routed into the pathway', async () => {
    const { service } = build({});

    await expect(service.assertIncidentResolvable('inc_untouched')).resolves.toBeUndefined();
  });

  it('blocks resolution while a case is in screening', async () => {
    const { service } = build({});
    await openScreeningCase(service, 'inc_1');

    await expect(service.assertIncidentResolvable('inc_1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('blocks resolution after a filing but before signoff', async () => {
    const { service } = build({ verified: true });
    const caseId = await openScreeningCase(service, 'inc_1');
    await service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT });
    await service.advance({
      caseId,
      to: 'filed',
      actorUserId: OPERATOR,
      audit: AUDIT,
      filingReference: 'APS-1',
    });

    await expect(service.assertIncidentResolvable('inc_1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('blocks resolution on a not-reportable determination that has not been reviewed', async () => {
    // The case that matters most: "we decided it was nothing" is exactly the
    // decision that must not close unreviewed.
    const { service } = build({});
    const caseId = await openScreeningCase(service, 'inc_1');
    await service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT });

    await expect(service.assertIncidentResolvable('inc_1')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('releases the incident once a reviewer signs off', async () => {
    const { service } = build({});
    const caseId = await openScreeningCase(service, 'inc_1');
    await service.advance({ caseId, to: 'not_reportable', actorUserId: OPERATOR, audit: AUDIT });
    await service.advance({ caseId, to: 'signed_off', actorUserId: REVIEWER, audit: AUDIT });

    await expect(service.assertIncidentResolvable('inc_1')).resolves.toBeUndefined();
  });
});

describe('MandatedReporterService.getCaseForIncident', () => {
  it('returns null when triage never routed the incident here', async () => {
    const { service } = build({});

    await expect(service.getCaseForIncident('inc_none')).resolves.toBeNull();
  });

  it('returns the case when one exists', async () => {
    const { service } = build({});
    await openScreeningCase(service, 'inc_1');

    const found = await service.getCaseForIncident('inc_1');
    expect(found?.incidentId).toBe('inc_1');
  });
});

describe('MandatedReporterService — jurisdiction kit (TS-303c1)', () => {
  it('lists the kit ordered by state code', async () => {
    const { service, prisma } = build({ stateCode: 'NY' });
    prisma.seedJurisdiction({ stateCode: 'CA', verified: true });

    const rows = await service.listJurisdictions();

    expect(rows.map((r) => r.stateCode)).toEqual(['CA', 'NY']);
  });

  it('narrows to the compliance backlog with unverifiedOnly', async () => {
    const { service, prisma } = build({ stateCode: 'NY', verified: false });
    prisma.seedJurisdiction({ stateCode: 'CA', verified: true });

    const rows = await service.listJurisdictions(true);

    expect(rows.map((r) => r.stateCode)).toEqual(['NY']);
  });

  it('creates a state row that did not exist, unverified', async () => {
    const { service } = build({ stateCode: 'NY' });

    const saved = await service.upsertJurisdiction({
      stateCode: 'CA',
      changes: { agencyName: 'Adult Protective Services' },
      audit: AUDIT,
    });

    expect(saved.stateCode).toBe('CA');
    expect(saved.agencyName).toBe('Adult Protective Services');
    expect(saved.verified).toBe(false);
  });

  it('records an attestation with attribution', async () => {
    const { service } = build({ stateCode: 'NY' });
    const at = new Date('2026-07-24T15:00:00.000Z');

    const saved = await service.setJurisdictionVerification(
      { stateCode: 'NY', verified: true, audit: AUDIT },
      at,
    );

    expect(saved.verified).toBe(true);
    expect(saved.verifiedAt).toEqual(at);
    expect(saved.verifiedByUserId).toBe(OPERATOR);
  });

  it('withdrawing an attestation clears its attribution', async () => {
    const { service } = build({ stateCode: 'NY' });
    await service.setJurisdictionVerification({ stateCode: 'NY', verified: true, audit: AUDIT });

    const saved = await service.setJurisdictionVerification({
      stateCode: 'NY',
      verified: false,
      audit: AUDIT,
    });

    expect(saved.verified).toBe(false);
    expect(saved.verifiedAt).toBeNull();
    expect(saved.verifiedByUserId).toBeNull();
  });

  it('withdrawing an attestation re-blocks filing prep in that state', async () => {
    // The point of withdrawal: a state whose statute has moved is pulled out
    // of service rather than left asserting a stale window.
    const { service } = build({ stateCode: 'NY', verified: true });
    const caseId = await openScreeningCase(service);
    await service.setJurisdictionVerification({
      stateCode: 'NY',
      verified: false,
      audit: AUDIT,
    });

    await expect(
      service.advance({ caseId, to: 'filing_prep', actorUserId: OPERATOR, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('editing a substantive field of a verified row CLEARS the attestation', async () => {
    // The attestation said "compliance checked THESE values". Change one and
    // it no longer covers what is stored — leaving the flag set would let an
    // unreviewed hotline pass the filing_prep gate on the strength of a
    // review of the number it replaced.
    const { service } = build({ stateCode: 'NY', verified: true });

    const saved = await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { reportingPhone: '555-0100' },
      audit: AUDIT,
    });

    expect(saved.verified).toBe(false);
    expect(saved.verifiedAt).toBeNull();
    expect(saved.verifiedByUserId).toBeNull();
  });

  it('a substantive edit that changes nothing does NOT clear the attestation', async () => {
    // Re-saving an unchanged form must not knock a state out of service.
    const { service } = build({ stateCode: 'NY', verified: true });
    await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { reportingPhone: '555-0100' },
      audit: AUDIT,
    });
    await service.setJurisdictionVerification({ stateCode: 'NY', verified: true, audit: AUDIT });

    const saved = await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { reportingPhone: '555-0100' },
      audit: AUDIT,
    });

    expect(saved.verified).toBe(true);
  });

  it('editing only the working notes does NOT clear the attestation', async () => {
    // Notes are commentary about the row, not a claim the review covered.
    const { service } = build({ stateCode: 'NY', verified: true });

    const saved = await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { notes: 'confirm whether our providers qualify as caregivers' },
      audit: AUDIT,
    });

    expect(saved.verified).toBe(true);
  });

  it('editing an UNverified row is a plain update — nothing to invalidate', async () => {
    const { service } = build({ stateCode: 'NY', verified: false });

    const saved = await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { statutoryDeadlineHours: 24 },
      audit: AUDIT,
    });

    expect(saved.statutoryDeadlineHours).toBe(24);
    expect(saved.verified).toBe(false);
  });

  it('audits every kit mutation with a distinguishable action', async () => {
    const { service, audit } = build({ stateCode: 'NY' });

    await service.upsertJurisdiction({
      stateCode: 'NY',
      changes: { agencyName: 'APS' },
      audit: AUDIT,
    });
    await service.setJurisdictionVerification({ stateCode: 'NY', verified: true, audit: AUDIT });
    await service.setJurisdictionVerification({ stateCode: 'NY', verified: false, audit: AUDIT });

    expect(audit.emitted.map((d) => d.action)).toEqual([
      'trust_safety_mandated_reporter_jurisdiction:upsert',
      'trust_safety_mandated_reporter_jurisdiction:verify',
      'trust_safety_mandated_reporter_jurisdiction:unverify',
    ]);
    expect(audit.emitted.every((d) => d.resourceId === 'NY')).toBe(true);
  });

  it('rejects a state code that is not a US jurisdiction', async () => {
    const { service } = build({ stateCode: 'NY' });

    await expect(
      service.upsertJurisdiction({ stateCode: 'ZZ', changes: {}, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('404s when verifying a state with no kit row', async () => {
    const { service } = build({ stateCode: 'NY' });

    await expect(
      service.setJurisdictionVerification({ stateCode: 'CA', verified: true, audit: AUDIT }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('MandatedReporterService.listCases (TS-303c2a)', () => {
  /**
   * Seeds a queue directly on the fake so each case's clock is controllable.
   * `statutoryDueAt` is what the ordering turns on, and going through
   * `openCase` would derive it from the jurisdiction's window instead.
   */
  function seedCases(
    prisma: FakeMandatedReporterPrisma,
    rows: ReadonlyArray<{
      id: string;
      status?: string;
      stateCode?: string;
      statutoryDueAt?: Date | null;
      openedAt?: Date;
    }>,
  ): void {
    for (const row of rows) {
      prisma.cases.push({
        id: row.id,
        incidentId: `inc_${row.id}`,
        stateCode: row.stateCode ?? 'NY',
        status: row.status ?? 'screening',
        openedByUserId: OPERATOR,
        openedAt: row.openedAt ?? OPENED_AT,
        statutoryDueAt: row.statutoryDueAt ?? null,
        filedAt: null,
        filingReference: null,
        determinationNotes: 'she flinched when he entered the room',
        reviewerUserId: null,
        reviewedAt: null,
        reviewerNotes: null,
        createdAt: OPENED_AT,
        updatedAt: OPENED_AT,
      });
    }
  }

  it('excludes signed_off cases by default — the queue is live work', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'a', status: 'screening' },
      { id: 'b', status: 'signed_off' },
      { id: 'c', status: 'not_reportable' },
    ]);

    const queue = await service.listCases({ limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('reaches the closed set on an explicit signed_off filter', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'a', status: 'screening' },
      { id: 'b', status: 'signed_off' },
    ]);

    const queue = await service.listCases({ status: 'signed_off', limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['b']);
  });

  it('filters to one status exactly', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'a', status: 'screening' },
      { id: 'b', status: 'filing_prep' },
      { id: 'c', status: 'filed' },
    ]);

    const queue = await service.listCases({ status: 'filing_prep', limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['b']);
  });

  it('sorts a null statutory deadline to the TOP, not the bottom', async () => {
    // A null deadline is "nobody established this state's window", which is
    // the case most likely to be missed — it must not age out below three
    // years of dated rows.
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'soon', statutoryDueAt: new Date('2026-07-25T00:00:00.000Z') },
      { id: 'unknown', statutoryDueAt: null },
      { id: 'later', statutoryDueAt: new Date('2026-08-01T00:00:00.000Z') },
    ]);

    const queue = await service.listCases({ limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['unknown', 'soon', 'later']);
  });

  it('breaks a deadline tie by open time, oldest first', async () => {
    const { service, prisma } = build({});
    const due = new Date('2026-07-25T00:00:00.000Z');
    seedCases(prisma, [
      { id: 'newer', statutoryDueAt: due, openedAt: new Date('2026-07-24T18:00:00.000Z') },
      { id: 'older', statutoryDueAt: due, openedAt: new Date('2026-07-24T06:00:00.000Z') },
    ]);

    const queue = await service.listCases({ limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['older', 'newer']);
  });

  it('filters by jurisdiction', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'ny', stateCode: 'NY' },
      { id: 'ca', stateCode: 'CA' },
    ]);

    const queue = await service.listCases({ stateCode: 'CA', limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['ca']);
  });

  it('normalises a lowercase state filter', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [{ id: 'ca', stateCode: 'CA' }]);

    const queue = await service.listCases({ stateCode: 'ca', limit: 50 });

    expect(queue.map((c) => c.id)).toEqual(['ca']);
  });

  it('rejects a state filter that is not a US jurisdiction rather than returning an empty queue', async () => {
    // "The queue is empty" is the most dangerous wrong answer this surface can
    // give, so a typo'd code is a 400 and not a silent zero-match.
    const { service, prisma } = build({});
    seedCases(prisma, [{ id: 'ny', stateCode: 'NY' }]);

    await expect(service.listCases({ stateCode: 'ZZ', limit: 50 })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('honours the limit', async () => {
    const { service, prisma } = build({});
    seedCases(prisma, [
      { id: 'a', statutoryDueAt: new Date('2026-07-25T00:00:00.000Z') },
      { id: 'b', statutoryDueAt: new Date('2026-07-26T00:00:00.000Z') },
      { id: 'c', statutoryDueAt: new Date('2026-07-27T00:00:00.000Z') },
    ]);

    const queue = await service.listCases({ limit: 2 });

    expect(queue.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('does not project the PHI-bearing notes fields out of Postgres at all', async () => {
    // The seeded rows carry determinationNotes; the projection must not fetch
    // them. Enforced at the SQL layer, not trimmed in a mapper (CLAUDE.md §3.9).
    const { service, prisma } = build({});
    seedCases(prisma, [{ id: 'a' }]);

    const queue = await service.listCases({ limit: 50 });

    expect(queue[0]).not.toHaveProperty('determinationNotes');
    expect(queue[0]).not.toHaveProperty('reviewerNotes');
  });

  it('returns an empty array when nothing is queued', async () => {
    const { service } = build({});

    await expect(service.listCases({ limit: 50 })).resolves.toEqual([]);
  });
});
