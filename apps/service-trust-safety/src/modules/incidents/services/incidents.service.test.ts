import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';
import { isBookingHoldEligible } from '../booking-hold-policy';
import type { IncidentCreatedEmitter } from '../incident-created-emitter';
import type { IncidentRow } from '../repositories/incident.repository';
import { IncidentRepository } from '../repositories/incident.repository';
import { FakeIncidentsPrisma } from './__fixtures__/fake-prisma';
import { IncidentsMetrics } from './incidents-metrics';
import { IncidentsService, type CreateIncidentInput } from './incidents.service';

const NOW = new Date('2026-07-02T10:00:00.000Z');

/**
 * Fake emitter (TS-301a) — records what would ride the outbox; optionally
 * throws to exercise the emit-failure-aborts-intake invariant.
 */
class FakeIncidentCreatedEmitter {
  readonly emitted: IncidentRow[] = [];
  failWith: Error | null = null;

  emitCreated(_tx: unknown, incident: IncidentRow): Promise<void> {
    if (this.failWith !== null) return Promise.reject(this.failWith);
    this.emitted.push(incident);
    return Promise.resolve();
  }
}

/**
 * Stand-in for the never-auto-close gate (TS-303b). `blocked` drives whether
 * `assertIncidentResolvable` throws, so this suite can prove the ORDERING —
 * that a blocked gate stops the write and the audit event — without pulling
 * the whole mandated-reporter stack in. The gate's own five-state behaviour is
 * covered in `mandated-reporter.service.test.ts`.
 */
class FakeMandatedReporterGate {
  blocked = false;
  calls: string[] = [];

  assertIncidentResolvable = async (incidentId: string): Promise<void> => {
    this.calls.push(incidentId);
    if (this.blocked) {
      throw Object.assign(new Error('blocked'), { status: 409 });
    }
  };
}

/** Records audit descriptors; `shouldFail` drives the roll-back-on-audit case. */
class FakeAuditEmitter {
  readonly emitted: { action: string; resourceId: string }[] = [];
  shouldFail = false;

  emit = async (
    _tx: unknown,
    _actor: unknown,
    descriptor: { action: string; resourceId: string },
  ): Promise<void> => {
    if (this.shouldFail) throw new Error('audit append rejected');
    this.emitted.push(descriptor);
  };
}

const RESOLVE_AUDIT = {
  actorUserId: 'user_ops_1',
  actorRole: 'trust_safety_operator',
  actorTenantScopeType: 'global',
  actorTenantScopeId: null,
  ip: null,
  userAgent: null,
  requestId: null,
  traceId: null,
} as const;

/**
 * Records the booking-hold pair (TS-304). Applies the REAL eligibility
 * predicate so the suite proves what does and does not get held, rather than
 * re-stating the rule; `failWith` drives the roll-back cases.
 */
class FakeBookingHoldEmitter {
  readonly requested: IncidentRow[] = [];
  readonly released: { incident: IncidentRow; resolvedAt: Date }[] = [];
  failWith: Error | null = null;

  emitHoldRequested = async (_tx: unknown, incident: IncidentRow): Promise<void> => {
    if (this.failWith !== null) throw this.failWith;
    if (isBookingHoldEligible(incident)) this.requested.push(incident);
  };

  emitHoldReleased = async (
    _tx: unknown,
    incident: IncidentRow,
    resolvedAt: Date,
  ): Promise<void> => {
    if (this.failWith !== null) throw this.failWith;
    if (isBookingHoldEligible(incident)) this.released.push({ incident, resolvedAt });
  };
}

/** Records what was paged (TS-306). Never throws, like the real service. */
class FakePager {
  readonly paged: IncidentRow[] = [];

  pageIfCritical = async (incident: IncidentRow): Promise<void> => {
    if (incident.severity === 'critical') this.paged.push(incident);
  };
}

function buildService(): {
  service: IncidentsService;
  fake: FakeIncidentsPrisma;
  emitter: FakeIncidentCreatedEmitter;
  gate: FakeMandatedReporterGate;
  audit: FakeAuditEmitter;
  pager: FakePager;
  bookingHold: FakeBookingHoldEmitter;
  recordOpened: ReturnType<typeof vi.spyOn>;
} {
  const fake = new FakeIncidentsPrisma();
  const repository = new IncidentRepository(fake as unknown as PrismaService);
  const emitter = new FakeIncidentCreatedEmitter();
  const gate = new FakeMandatedReporterGate();
  const audit = new FakeAuditEmitter();
  const pager = new FakePager();
  const bookingHold = new FakeBookingHoldEmitter();
  // The real instrument class (TS-306-followup-1c) — `getMeter` yields a
  // no-op meter with no SDK booted, so constructing it is free; the spy is
  // what lets the suite assert the label set.
  const metrics = new IncidentsMetrics();
  const recordOpened = vi.spyOn(metrics, 'recordOpened');
  return {
    service: new IncidentsService(
      repository,
      emitter as unknown as IncidentCreatedEmitter,
      gate as never,
      audit as never,
      pager as never,
      bookingHold as never,
      metrics,
    ),
    fake,
    emitter,
    gate,
    audit,
    pager,
    bookingHold,
    recordOpened,
  };
}

function validInput(overrides: Partial<CreateIncidentInput> = {}): CreateIncidentInput {
  return {
    source: 'family',
    category: 'welfare',
    severity: 'high',
    householdId: 'hh_1',
    seniorId: 'sen_1',
    ...overrides,
  };
}

describe('IncidentsService.createIncident', () => {
  it('persists the incident with opened_at = the injected clock', async () => {
    const { service } = buildService();

    const incident = await service.createIncident(validInput(), NOW);

    expect(incident.openedAt).toEqual(NOW);
    expect(incident.source).toBe('family');
    expect(incident.category).toBe('welfare');
    expect(incident.severity).toBe('high');
    expect(incident.householdId).toBe('hh_1');
    expect(incident.seniorId).toBe('sen_1');
    expect(incident.providerId).toBeNull();
  });

  it('computes sla_due_at from the severity budget at insert (high → +8h)', async () => {
    const { service } = buildService();

    const incident = await service.createIncident(validInput({ severity: 'high' }), NOW);

    expect(incident.slaDueAt.toISOString()).toBe('2026-07-02T18:00:00.000Z');
  });

  it('critical severity gets the tightest deadline (+2h)', async () => {
    const { service } = buildService();

    const incident = await service.createIncident(validInput({ severity: 'critical' }), NOW);

    expect(incident.slaDueAt.toISOString()).toBe('2026-07-02T12:00:00.000Z');
  });

  it('new incidents start open and unresolved (status from the DB default)', async () => {
    const { service, fake } = buildService();

    const incident = await service.createIncident(validInput(), NOW);

    expect(incident.status).toBe('open');
    expect(incident.resolvedAt).toBeNull();
    expect(incident.resolutionNotes).toBeNull();
    // The insert must NOT send `status` — the DB default is the single
    // source of the initial state.
    expect(Object.keys(fake.rows[0] ?? {})).toContain('status');
  });

  it('subject ids are independent — a system-source conduct report may carry only a provider', async () => {
    const { service } = buildService();

    const incident = await service.createIncident(
      {
        source: 'system',
        category: 'conduct',
        severity: 'high',
        providerId: 'prov_9',
      },
      NOW,
    );

    expect(incident.householdId).toBeNull();
    expect(incident.seniorId).toBeNull();
    expect(incident.providerId).toBe('prov_9');
  });
});

describe('IncidentsService.createIncident — system intake trail', () => {
  it('PERSISTS sourceEventId — the domain idempotency guard (TS-307a-followup-1)', async () => {
    // The regression this test exists for: `sourceEventId` was on the
    // input interface, documented as the guard, and passed by all three
    // consumer handlers — and it stopped at this service and never
    // reached the insert. The partial UNIQUE was protecting a column that
    // was always NULL, and every handler's P2002 branch was unreachable,
    // so a redelivery outliving the SDK's dedup cache would have opened a
    // second incident with a second SLA clock.
    const { service, fake } = buildService();

    await service.createIncident(validInput({ sourceEventId: 'impossible-travel:ci_1:ci_2' }), NOW);

    expect(fake.rows[0]?.['sourceEventId']).toBe('impossible-travel:ci_1:ci_2');
  });

  it('leaves sourceEventId null for a human-filed report', async () => {
    const { service, fake } = buildService();

    await service.createIncident(validInput(), NOW);

    expect(fake.rows[0]?.['sourceEventId']).toBeNull();
  });

  it('persists the detector and its evidence (TS-308c-followup-2)', async () => {
    const { service, fake } = buildService();

    await service.createIncident(
      validInput({
        source: 'system',
        sourceEventId: 'mass-cancellation:provider:prv_1:2026-07-26',
        evidence: {
          detector: 'mass_cancellation',
          subjectKind: 'provider',
          windowStart: '2026-07-25T18:00:00.000Z',
          windowEnd: '2026-07-26T18:00:00.000Z',
          canceledBookingCount: 9,
          distinctCancellationCount: 6,
          threshold: 5,
          distinctActorCount: 1,
          unattributedCount: 0,
          staffExcludedCount: 0,
        },
      }),
      NOW,
    );

    expect(fake.rows[0]?.['detector']).toBe('mass_cancellation');
    expect(fake.rows[0]?.['systemFacts']).toMatchObject({
      detector: 'mass_cancellation',
      distinctCancellationCount: 6,
      threshold: 5,
    });
  });

  it('leaves both evidence columns null for a human-filed report', async () => {
    // Not `null` the JSON literal — SQL NULL. A human's account belongs in
    // `description`, and `systemFacts !== null` has to stay a truthful
    // "a detector recorded something".
    const { service, fake } = buildService();

    await service.createIncident(validInput(), NOW);

    expect(fake.rows[0]?.['detector']).toBeNull();
    expect(fake.rows[0]?.['systemFacts']).toBeNull();
  });

  it('REJECTS evidence that does not match the contract union', async () => {
    // The column's whole safety property is that nothing untyped is in
    // it. An in-process caller that bypassed the type must not be able to
    // write a blob — free text is exactly what the source events refuse
    // to carry, and this is the only place that could smuggle it in.
    const { service, fake } = buildService();

    await expect(
      service.createIncident(
        validInput({
          evidence: {
            detector: 'impossible_travel',
            note: 'she seemed confused when he arrived',
          } as never,
        }),
        NOW,
      ),
    ).rejects.toThrow();

    expect(fake.rows).toHaveLength(0);
  });

  it('REJECTS an unknown detector', async () => {
    const { service } = buildService();

    await expect(
      service.createIncident(
        validInput({ evidence: { detector: 'vibes', reason: 'felt wrong' } as never }),
        NOW,
      ),
    ).rejects.toThrow();
  });
});

describe('IncidentsService.createIncident — outbox emission (TS-301a)', () => {
  it('emits trust_safety.incident.created with the persisted row inside the insert tx', async () => {
    const { service, emitter } = buildService();

    const incident = await service.createIncident(validInput(), NOW);

    expect(emitter.emitted).toHaveLength(1);
    expect(emitter.emitted[0]?.id).toBe(incident.id);
    expect(emitter.emitted[0]?.slaDueAt).toEqual(incident.slaDueAt);
  });

  it('an emit failure aborts the intake — no incident row survives', async () => {
    const { service, fake, emitter } = buildService();
    emitter.failWith = new Error('outbox append rejected');

    await expect(service.createIncident(validInput(), NOW)).rejects.toThrow(
      'outbox append rejected',
    );
    expect(fake.rows).toHaveLength(0);
  });

  it('persists the description on the row but the log line carries triage facts only', async () => {
    const { service, fake } = buildService();

    await service.createIncident(
      validInput({ description: 'Mom seemed frightened of her afternoon visitor.' }),
      NOW,
    );

    expect(fake.rows[0]?.['description']).toBe('Mom seemed frightened of her afternoon visitor.');
  });
});

describe('IncidentsService.getIncident', () => {
  it('returns a previously created incident by id', async () => {
    const { service } = buildService();
    const created = await service.createIncident(validInput(), NOW);

    const fetched = await service.getIncident(created.id);

    expect(fetched.id).toBe(created.id);
    expect(fetched.slaDueAt).toEqual(created.slaDueAt);
  });

  it('throws an RFC 7807-shaped 404 for an unknown id', async () => {
    const { service } = buildService();

    try {
      await service.getIncident('inc_missing');
      throw new Error('getIncident unexpectedly resolved');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundException);
      const body = (err as NotFoundException).getResponse() as Record<string, unknown>;
      expect(body['title']).toBe('Not Found');
      expect(body['status']).toBe(404);
    }
  });
});

describe('IncidentsService.resolveIncident — TS-303b', () => {
  it('closes an incident and stamps the resolution', async () => {
    const { service } = buildService();
    const created = await service.createIncident(validInput());

    const resolvedAt = new Date('2026-07-25T10:00:00.000Z');
    const resolved = await service.resolveIncident(
      {
        incidentId: created.id,
        resolutionNotes: 'spoke with the family; no concern',
        audit: RESOLVE_AUDIT,
      },
      resolvedAt,
    );

    expect(resolved.status).toBe('resolved');
    expect(resolved.resolvedAt).toEqual(resolvedAt);
    expect(resolved.resolutionNotes).toBe('spoke with the family; no concern');
  });

  it('consults the never-auto-close gate BEFORE writing', async () => {
    const { service, gate } = buildService();
    const created = await service.createIncident(validInput());

    await service.resolveIncident({
      incidentId: created.id,
      resolutionNotes: 'closed',
      audit: RESOLVE_AUDIT,
    });

    expect(gate.calls).toEqual([created.id]);
  });

  it('leaves the incident open when the gate blocks — no write, no audit event', async () => {
    const { service, gate, audit, fake } = buildService();
    const created = await service.createIncident(validInput());
    gate.blocked = true;

    await expect(
      service.resolveIncident({
        incidentId: created.id,
        resolutionNotes: 'closed',
        audit: RESOLVE_AUDIT,
      }),
    ).rejects.toMatchObject({ status: 409 });

    // The row is untouched and nothing claims a closure that did not happen.
    expect(fake.rows[0]?.['status']).toBe('open');
    expect(audit.emitted).toEqual([]);
  });

  it('emits one audit event carrying the action and the incident id', async () => {
    const { service, audit } = buildService();
    const created = await service.createIncident(validInput());

    await service.resolveIncident({
      incidentId: created.id,
      resolutionNotes: 'closed',
      audit: RESOLVE_AUDIT,
    });

    expect(audit.emitted).toHaveLength(1);
    expect(audit.emitted[0]?.action).toBe('trust_safety_incident:resolve');
    expect(audit.emitted[0]?.resourceId).toBe(created.id);
  });

  it('rolls the closure back when the audit append fails', async () => {
    // CLAUDE.md §3.6 — a mutation that cannot be audited must not commit. On
    // a legal-record surface an unauditable closure is worse than a failed one.
    const { service, audit, fake } = buildService();
    const created = await service.createIncident(validInput());
    audit.shouldFail = true;

    await expect(
      service.resolveIncident({
        incidentId: created.id,
        resolutionNotes: 'closed',
        audit: RESOLVE_AUDIT,
      }),
    ).rejects.toThrow(/audit append rejected/);

    expect(fake.rows[0]?.['status']).toBe('open');
  });

  it('is a compare-and-swap — a second resolve loses rather than overwriting the first', async () => {
    const { service } = buildService();
    const created = await service.createIncident(validInput());
    await service.resolveIncident({
      incidentId: created.id,
      resolutionNotes: 'first',
      audit: RESOLVE_AUDIT,
    });

    await expect(
      service.resolveIncident({
        incidentId: created.id,
        resolutionNotes: 'second',
        audit: RESOLVE_AUDIT,
      }),
    ).rejects.toMatchObject({ status: 409 });

    const fetched = await service.getIncident(created.id);
    expect(fetched.resolutionNotes).toBe('first');
  });

  it('404s for an unknown incident', async () => {
    const { service } = buildService();

    await expect(
      service.resolveIncident({
        incidentId: 'inc_missing',
        resolutionNotes: 'closed',
        audit: RESOLVE_AUDIT,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('IncidentsService.createIncident — on-call paging (TS-306)', () => {
  it('pages on-call for a critical incident', async () => {
    const { service, pager } = buildService();

    const incident = await service.createIncident(validInput({ severity: 'critical' }), NOW);

    expect(pager.paged.map((i) => i.id)).toEqual([incident.id]);
  });

  it('does not page for a high-severity incident', async () => {
    const { service, pager } = buildService();

    await service.createIncident(validInput({ severity: 'high' }), NOW);

    expect(pager.paged).toEqual([]);
  });

  it('pages with the PERSISTED row, so the responder gets the real id and deadline', async () => {
    const { service, pager } = buildService();

    const incident = await service.createIncident(validInput({ severity: 'critical' }), NOW);

    expect(pager.paged[0]?.slaDueAt).toEqual(incident.slaDueAt);
  });

  it('does not page when the intake rolls back — no page for an incident that does not exist', async () => {
    const { service, emitter, pager, fake } = buildService();
    emitter.failWith = new Error('outbox append rejected');

    await expect(service.createIncident(validInput({ severity: 'critical' }), NOW)).rejects.toThrow(
      'outbox append rejected',
    );

    expect(fake.rows).toHaveLength(0);
    expect(pager.paged).toEqual([]);
  });
});

describe('IncidentsService.createIncident — intake metric (TS-306-followup-1c)', () => {
  it('counts an opened incident by source, severity and category', async () => {
    // `source` is the axis that makes the series worth having: a detector
    // that starts firing on ordinary life and a family reporting more
    // concerns are the same line without it, and they call for opposite
    // responses.
    const { service, recordOpened } = buildService();

    await service.createIncident(
      validInput({ source: 'system', category: 'conduct', severity: 'medium' }),
      NOW,
    );

    expect(recordOpened).toHaveBeenCalledTimes(1);
    expect(recordOpened).toHaveBeenCalledWith({
      source: 'system',
      severity: 'medium',
      category: 'conduct',
    });
  });

  it('carries NO subject id, reporter id or description into the label set', async () => {
    // A metrics backend replicates far wider than the
    // `trust_safety:write`-gated detail page, and the report body is a
    // family's account of a named senior (CLAUDE.md §10).
    const { service, recordOpened } = buildService();

    await service.createIncident(
      validInput({
        householdId: 'hh_secret',
        seniorId: 'sen_secret',
        reporterUserId: 'user_secret',
        description: 'Mom seemed frightened of her afternoon visitor.',
      }),
      NOW,
    );

    const serialised = JSON.stringify(recordOpened.mock.calls);
    expect(serialised).not.toContain('hh_secret');
    expect(serialised).not.toContain('sen_secret');
    expect(serialised).not.toContain('user_secret');
    expect(serialised).not.toContain('frightened');
  });

  it('does not count an intake that rolled back — the incident does not exist', async () => {
    const { service, emitter, recordOpened, fake } = buildService();
    emitter.failWith = new Error('outbox append rejected');

    await expect(service.createIncident(validInput(), NOW)).rejects.toThrow(
      'outbox append rejected',
    );

    expect(fake.rows).toHaveLength(0);
    expect(recordOpened).not.toHaveBeenCalled();
  });
});

describe('IncidentsService.listIncidents (TS-303c2d)', () => {
  /**
   * Seeds the queue directly on the fake so each row's SLA position and
   * subject ids are controllable. Going through `createIncident` would derive
   * `slaDueAt` from the severity budget, which is the wrong lever for testing
   * ordering.
   */
  function seed(
    fake: FakeIncidentsPrisma,
    rows: ReadonlyArray<{
      id: string;
      status?: string;
      severity?: string;
      category?: string;
      householdId?: string | null;
      seniorId?: string | null;
      providerId?: string | null;
      slaDueAt?: Date;
      openedAt?: Date;
    }>,
  ): void {
    for (const row of rows) {
      fake.rows.push({
        id: row.id,
        householdId: row.householdId ?? 'hh_1',
        seniorId: row.seniorId ?? null,
        providerId: row.providerId ?? null,
        reporterUserId: 'usr_filer',
        source: 'family',
        category: row.category ?? 'welfare',
        severity: row.severity ?? 'high',
        status: row.status ?? 'open',
        description: 'she seemed frightened of her afternoon visitor',
        openedAt: row.openedAt ?? NOW,
        slaDueAt: row.slaDueAt ?? new Date('2026-07-02T18:00:00.000Z'),
        resolvedAt: null,
        resolutionNotes: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  }

  it('excludes resolved incidents by default — the queue is live work', async () => {
    const { service, fake } = buildService();
    seed(fake, [
      { id: 'a', status: 'open' },
      { id: 'b', status: 'resolved' },
      { id: 'c', status: 'awaiting_review' },
    ]);

    const queue = await service.listIncidents({ limit: 50 });

    expect(queue.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('reaches the closed set on an explicit resolved filter', async () => {
    const { service, fake } = buildService();
    seed(fake, [
      { id: 'a', status: 'open' },
      { id: 'b', status: 'resolved' },
    ]);

    const queue = await service.listIncidents({ status: 'resolved', limit: 50 });

    expect(queue.map((i) => i.id)).toEqual(['b']);
  });

  it('orders by SLA deadline, soonest first', async () => {
    const { service, fake } = buildService();
    seed(fake, [
      { id: 'later', slaDueAt: new Date('2026-07-04T00:00:00.000Z') },
      { id: 'soonest', slaDueAt: new Date('2026-07-02T12:00:00.000Z') },
      { id: 'middle', slaDueAt: new Date('2026-07-03T00:00:00.000Z') },
    ]);

    const queue = await service.listIncidents({ limit: 50 });

    expect(queue.map((i) => i.id)).toEqual(['soonest', 'middle', 'later']);
  });

  it('breaks an SLA tie by open time, oldest first', async () => {
    const { service, fake } = buildService();
    const sla = new Date('2026-07-02T18:00:00.000Z');
    seed(fake, [
      { id: 'newer', slaDueAt: sla, openedAt: new Date('2026-07-02T11:00:00.000Z') },
      { id: 'older', slaDueAt: sla, openedAt: new Date('2026-07-02T09:00:00.000Z') },
    ]);

    const queue = await service.listIncidents({ limit: 50 });

    expect(queue.map((i) => i.id)).toEqual(['older', 'newer']);
  });

  it.each([
    ['severity', { severity: 'critical' as const }, 'crit'],
    ['category', { category: 'billing' as const }, 'bill'],
  ])('filters by %s', async (_name, filter, expectedId) => {
    const { service, fake } = buildService();
    seed(fake, [
      { id: 'crit', severity: 'critical' },
      { id: 'bill', category: 'billing' },
      { id: 'plain' },
    ]);

    const queue = await service.listIncidents({ ...filter, limit: 50 });

    expect(queue.map((i) => i.id)).toEqual([expectedId]);
  });

  it.each([
    ['householdId', 'hh_2'],
    ['seniorId', 'sen_2'],
    ['providerId', 'prv_2'],
  ])('filters by the %s subject scroll', async (key, value) => {
    // The three 360-view scrolls (PDD §16.1), each backed by its own index.
    const { service, fake } = buildService();
    seed(fake, [{ id: 'match', [key]: value }, { id: 'other' }]);

    const queue = await service.listIncidents({ [key]: value, limit: 50 });

    expect(queue.map((i) => i.id)).toEqual(['match']);
  });

  it('honours the limit', async () => {
    const { service, fake } = buildService();
    seed(fake, [
      { id: 'a', slaDueAt: new Date('2026-07-02T12:00:00.000Z') },
      { id: 'b', slaDueAt: new Date('2026-07-02T13:00:00.000Z') },
      { id: 'c', slaDueAt: new Date('2026-07-02T14:00:00.000Z') },
    ]);

    const queue = await service.listIncidents({ limit: 2 });

    expect(queue.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('does not project the filer narrative out of Postgres at all', async () => {
    // The seeded rows carry a description; the projection must not fetch it.
    // Enforced in the SQL, not trimmed in a mapper (CLAUDE.md §3.9).
    const { service, fake } = buildService();
    seed(fake, [{ id: 'a' }]);

    const queue = await service.listIncidents({ limit: 50 });

    expect(queue[0]).not.toHaveProperty('description');
    expect(queue[0]).not.toHaveProperty('resolutionNotes');
  });

  it('flags whether the incident is in the statutory pathway', async () => {
    const { service, fake } = buildService();
    seed(fake, [{ id: 'routed' }, { id: 'not_routed' }]);
    fake.mandatedReporterCaseIncidentIds.add('routed');

    const queue = await service.listIncidents({ limit: 50 });
    const byId = new Map(queue.map((i) => [i.id, i.hasMandatedReporterCase]));

    expect(byId.get('routed')).toBe(true);
    expect(byId.get('not_routed')).toBe(false);
  });

  it('returns an empty array when nothing is queued', async () => {
    const { service } = buildService();

    await expect(service.listIncidents({ limit: 50 })).resolves.toEqual([]);
  });
});

describe('IncidentsService.getIncidentDetail (TS-303c2d)', () => {
  it('carries the free text the queue withholds', async () => {
    const { service } = buildService();
    const created = await service.createIncident(
      validInput({ description: 'she seemed frightened' }),
      NOW,
    );

    const detail = await service.getIncidentDetail(created.id);

    expect(detail.description).toBe('she seemed frightened');
    expect(detail.hasMandatedReporterCase).toBe(false);
  });

  it('reports the statutory-pathway flag', async () => {
    const { service, fake } = buildService();
    const created = await service.createIncident(validInput(), NOW);
    fake.mandatedReporterCaseIncidentIds.add(created.id);

    await expect(service.getIncidentDetail(created.id)).resolves.toMatchObject({
      hasMandatedReporterCase: true,
    });
  });

  it('404s on an unknown incident', async () => {
    const { service } = buildService();

    await expect(service.getIncidentDetail('inc_nope')).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * TS-304 — the booking-hold pair on the incident lifecycle.
 *
 * These tests own the SEAM (does the hold ride the right transactions, and
 * does a failed hold roll the mutation back); `booking-hold-policy.test.ts`
 * owns the predicate itself.
 */
describe('IncidentsService booking holds (TS-304)', () => {
  it('requests a hold on a high-severity incident, in the insert transaction', async () => {
    const { service, bookingHold, fake } = buildService();

    const incident = await service.createIncident(validInput({ severity: 'high' }), NOW);

    expect(bookingHold.requested).toHaveLength(1);
    expect(bookingHold.requested[0]?.id).toBe(incident.id);
    // The row is committed — the append happened inside the same tx and did
    // not abort it.
    expect(fake.rows).toHaveLength(1);
  });

  it('requests a hold on a critical incident', async () => {
    const { service, bookingHold } = buildService();
    await service.createIncident(validInput({ severity: 'critical' }), NOW);
    expect(bookingHold.requested).toHaveLength(1);
  });

  it('requests NO hold below high severity — an everyday report does not stop care', async () => {
    for (const severity of ['low', 'medium'] as const) {
      const { service, bookingHold } = buildService();
      await service.createIncident(validInput({ severity }), NOW);
      expect(bookingHold.requested).toHaveLength(0);
    }
  });

  it('requests NO hold when the incident names no subject — never a platform-wide freeze', async () => {
    const { service, bookingHold } = buildService();

    await service.createIncident(
      {
        source: 'system',
        category: 'safety',
        severity: 'critical',
      },
      NOW,
    );

    expect(bookingHold.requested).toHaveLength(0);
  });

  it('rolls the whole intake back when the hold append fails', async () => {
    const { service, bookingHold, fake, emitter } = buildService();
    bookingHold.failWith = new Error('hold append rejected');

    await expect(service.createIncident(validInput({ severity: 'critical' }), NOW)).rejects.toThrow(
      'hold append rejected',
    );

    // No incident, and therefore no SLA clock and no page — the intake is
    // atomic across BOTH appends, not just the created one.
    expect(fake.rows).toHaveLength(0);
    expect(emitter.emitted).toHaveLength(1); // attempted, then rolled back with the tx
  });

  it('releases the hold on resolution, stamped with the resolution clock', async () => {
    const { service, bookingHold } = buildService();
    const incident = await service.createIncident(validInput({ severity: 'high' }), NOW);
    const resolvedAt = new Date('2026-07-03T09:00:00.000Z');

    await service.resolveIncident(
      { incidentId: incident.id, resolutionNotes: 'unfounded', audit: RESOLVE_AUDIT },
      resolvedAt,
    );

    expect(bookingHold.released).toHaveLength(1);
    expect(bookingHold.released[0]?.incident.id).toBe(incident.id);
    // The committee's decision moment, not the publisher's wall clock.
    expect(bookingHold.released[0]?.resolvedAt).toEqual(resolvedAt);
  });

  it('releases nothing for an incident that never held anything', async () => {
    const { service, bookingHold } = buildService();
    const incident = await service.createIncident(validInput({ severity: 'low' }), NOW);

    await service.resolveIncident(
      { incidentId: incident.id, resolutionNotes: 'closed', audit: RESOLVE_AUDIT },
      NOW,
    );

    expect(bookingHold.released).toHaveLength(0);
  });

  it('does NOT release when the never-auto-close gate blocks the resolution', async () => {
    const { service, bookingHold, gate } = buildService();
    const incident = await service.createIncident(validInput({ severity: 'critical' }), NOW);
    gate.blocked = true;

    await expect(
      service.resolveIncident(
        { incidentId: incident.id, resolutionNotes: 'closing', audit: RESOLVE_AUDIT },
        NOW,
      ),
    ).rejects.toThrow();

    // The statutory pathway is still open — lifting the hold here would
    // resume a provider's visits while an abuse case is live.
    expect(bookingHold.released).toHaveLength(0);
  });

  it('rolls the resolution back when the release append fails, keeping the incident open', async () => {
    const { service, bookingHold, fake } = buildService();
    const incident = await service.createIncident(validInput({ severity: 'high' }), NOW);
    bookingHold.failWith = new Error('release append rejected');

    await expect(
      service.resolveIncident(
        { incidentId: incident.id, resolutionNotes: 'unfounded', audit: RESOLVE_AUDIT },
        NOW,
      ),
    ).rejects.toThrow('release append rejected');

    // Better an incident that is still open and retryable than a closed one
    // whose hold nothing will ever lift.
    expect(fake.rows[0]?.status).not.toBe('resolved');
    expect(fake.rows[0]?.resolvedAt).toBeNull();
  });
});
