import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  TrustSafetySystemEvidenceSchema,
  type TrustSafetySystemEvidence,
} from '@taste-and-see/contracts';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';

import type { AuditActorContext } from '@taste-and-see/nest-audit';
import { AuditEmitter } from '@taste-and-see/nest-audit';
import { TRUST_SAFETY_AUDIT_RESOURCE } from '../../audit/audit-resources';
import { MandatedReporterService } from '../../mandated-reporter/services/mandated-reporter.service';
import type { IncidentCategory, IncidentSeverity, IncidentSource } from '../incident-enums';
import { IncidentPagerService } from './incident-pager.service';
import { IncidentsMetrics } from './incidents-metrics';
import { BookingHoldEmitter } from '../booking-hold-emitter';
import { IncidentCreatedEmitter } from '../incident-created-emitter';
import { computeSlaDueAt } from '../sla';
import {
  IncidentRepository,
  type IncidentDetailRow,
  type IncidentRow,
  type IncidentSummaryRow,
  type ListIncidentsFilter,
} from '../repositories/incident.repository';

/**
 * Intake input for the internal incident seam. Subject ids are optional and
 * independent — an incident may concern any subset (a provider-conduct
 * report has no household; a billing report has no provider). Boundary
 * validation (Zod DTOs, who may file what, free-text report bodies) is the
 * TS-301 intake surface's job; this seam trusts its in-process callers.
 */
export interface CreateIncidentInput {
  readonly source: IncidentSource;
  readonly category: IncidentCategory;
  readonly severity: IncidentSeverity;
  readonly householdId?: string;
  readonly seniorId?: string;
  readonly providerId?: string;
  /**
   * The verified `userId` of the actor who filed the report (TS-301b), taken
   * from the access token by the intake surface — never from a request body.
   * Absent on system-sourced incidents, which have no human filer.
   *
   * On the provider path this is the ONLY attribution the row carries (a
   * provider token is `tenantScope: global` with no `providerId` claim), so
   * `providerId` stays undefined there and is linked at triage.
   */
  readonly reporterUserId?: string;
  /**
   * The filer's free-text report (TS-301a intake). Absent on system-sourced
   * incidents. PII/PHI — persisted on the row, never on events or logs.
   */
  readonly description?: string;
  /**
   * TS-307a — the outbox `event_id` that produced this incident. Set ONLY by
   * event-sourced intake (the outbox-consumer handlers); every HTTP intake
   * path leaves it absent.
   *
   * It is the domain-level idempotency key, backed by a partial UNIQUE. A
   * second insert with the same value raises Prisma P2002, which the caller
   * treats as "already handled" — the consumer SDK's dedup table normally
   * stops a redelivery long before this, but that table is a cache and this
   * is the constraint.
   */
  readonly sourceEventId?: string;
  /**
   * TS-308c-followup-2 — what the detector that opened this incident
   * recorded. Set ONLY by the outbox-consumer handlers; human-filed intake
   * leaves it absent, because a human's account belongs in `description`.
   *
   * A DISCRIMINATED UNION, not a bag: every field is a scalar, an opaque id
   * or a timestamp, named at the contract layer. That is what stops this
   * becoming the free-text channel the source events deliberately refuse to
   * be. Re-validated below before it is persisted, so an in-process caller
   * that bypassed the type cannot write an unvalidated blob.
   */
  readonly evidence?: TrustSafetySystemEvidence;
}

/**
 * Domain logic for trust & safety incidents (TS-300 skeleton; TS-301a
 * outbox emission).
 *
 * `createIncident` is the single insert path: it stamps `openedAt`,
 * computes the SLA deadline ONCE at insert (severity budget — see sla.ts) so
 * the future breach sweep (TS-306) is a pure indexed scan, and emits
 * `trust_safety.incident.created` INSIDE the insert transaction — every
 * created incident durably queues its signal, regardless of which caller
 * created it (the TS-301a intake today; the TS-302 escalation consumers
 * later). An emit failure aborts the insert: for a welfare concern,
 * "stored but never surfaced" is the exact silent failure CLAUDE.md §12
 * forbids.
 *
 * Observability: one info log per created incident carrying ids + triage
 * facts only (never report bodies / PII — CLAUDE.md §10), plus
 * `trust_safety_incidents_opened_total{source,severity,category}` since
 * TS-306-followup-1c wired the service's meter provider. The log line was
 * described as "counter-ready" from TS-300 onwards; this is the counter.
 */
@Injectable()
export class IncidentsService {
  private readonly logger = new Logger(IncidentsService.name);

  constructor(
    private readonly incidents: IncidentRepository,
    private readonly emitter: IncidentCreatedEmitter,
    private readonly mandatedReporter: MandatedReporterService,
    private readonly audit: AuditEmitter,
    private readonly pager: IncidentPagerService,
    private readonly bookingHold: BookingHoldEmitter,
    private readonly metrics: IncidentsMetrics,
  ) {}

  /**
   * @param now injectable clock (CLAUDE.md §9.3 — deterministic tests, no
   *            sleeps). Defaults to wall-clock; TS-302's backfill path may
   *            pass the source event's timestamp so a late-ingested flag
   *            keeps its true deadline.
   */
  async createIncident(input: CreateIncidentInput, now: Date = new Date()): Promise<IncidentRow> {
    const openedAt = now;
    const slaDueAt = computeSlaDueAt(input.severity, openedAt);
    // Validated HERE rather than trusted from the caller: the seam's other
    // fields are trusted in-process (see the interface doc-block), but this
    // one lands in a JSONB column whose whole safety property is that
    // nothing untyped is in it. A parse failure is a programming error, so
    // it throws — an incident with an unvalidated blob must not exist, and
    // the consumer SDK will redeliver after the bug is fixed.
    const evidence =
      input.evidence === undefined ? null : TrustSafetySystemEvidenceSchema.parse(input.evidence);

    const incident = await this.incidents.insert(
      {
        householdId: input.householdId ?? null,
        seniorId: input.seniorId ?? null,
        providerId: input.providerId ?? null,
        reporterUserId: input.reporterUserId ?? null,
        source: input.source,
        category: input.category,
        severity: input.severity,
        description: input.description ?? null,
        openedAt,
        slaDueAt,
        // TS-307a-followup-1: this line is the fix for a real defect.
        // `sourceEventId` was on `CreateIncidentInput`, documented as the
        // domain idempotency guard, and passed by all three consumer
        // handlers — but it stopped here and never reached the insert. The
        // partial UNIQUE was guarding a column that was always NULL, and
        // the P2002 branch in every handler was unreachable. A redelivery
        // that outlived the SDK's dedup cache would have opened a second
        // incident with a second SLA clock.
        sourceEventId: input.sourceEventId ?? null,
        detector: evidence?.detector ?? null,
        systemFacts: evidence ?? null,
      },
      // In-tx outbox emission (CLAUDE.md §5.3): the created signal commits
      // atomically with the row or the whole intake rolls back.
      //
      // TS-304 adds a SECOND in-tx append on the same seam: a `high` /
      // `critical` incident naming a subject also queues the booking hold.
      // Sequential, not `Promise.all` — both writes go to the same
      // transaction client, and interleaving two appends on one connection
      // is how you get a "cannot run concurrent queries" surprise under
      // load rather than in tests. The hold emitter is a no-op for
      // non-eligible incidents, so this call site stays unconditional.
      async (tx, created) => {
        const executor = tx as unknown as OutboxRawExecutor;
        await this.emitter.emitCreated(executor, created);
        await this.bookingHold.emitHoldRequested(executor, created);
      },
    );

    this.logger.log(
      `trust_safety.incident.created ${JSON.stringify({
        incidentId: incident.id,
        source: incident.source,
        category: incident.category,
        severity: incident.severity,
        householdId: incident.householdId,
        seniorId: incident.seniorId,
        providerId: incident.providerId,
        reporterUserId: incident.reporterUserId,
        detector: incident.detector,
        slaDueAt: incident.slaDueAt.toISOString(),
      })}`,
    );

    // TS-306-followup-1c — the counter the log line above has been
    // "counter-ready" for since TS-300. Recorded after the commit for the
    // same reason the page is: a rolled-back intake did not open an
    // incident and must not appear in the count.
    this.metrics.recordOpened({
      source: incident.source,
      severity: incident.severity,
      category: incident.category,
    });

    // Page on-call AFTER the transaction has committed (TS-306). Best-effort
    // and never throws: the incident is already durable with its SLA clock
    // running, so a paging failure must not roll it back or fail the filer's
    // request. A no-op for non-critical severities.
    await this.pager.pageIfCritical(incident);

    return incident;
  }

  /**
   * Close an incident (TS-303b). **The only path in the platform that sets an
   * incident to `resolved`**, which is what makes CLAUDE.md §12's
   * never-auto-close rule enforceable rather than aspirational: the
   * mandated-reporter gate is consulted here, first, before anything is
   * written. An incident whose statutory case has not been signed off gets a
   * 409 and stays open.
   *
   * The ordering matters and is not incidental — the gate runs BEFORE the
   * update, so a blocked closure never touches the row and never emits an
   * audit event claiming it did.
   */
  async resolveIncident(
    input: {
      readonly incidentId: string;
      readonly resolutionNotes: string;
      readonly audit: AuditActorContext;
    },
    now: Date = new Date(),
  ): Promise<IncidentRow> {
    const before = await this.getIncident(input.incidentId);

    // CLAUDE.md §12. Throws 409 while a mandated-reporter case is live;
    // a no-op when the incident was never routed into the statutory pathway.
    await this.mandatedReporter.assertIncidentResolvable(input.incidentId);

    const resolved = await this.incidents.resolve(
      input.incidentId,
      { resolvedAt: now, resolutionNotes: input.resolutionNotes },
      async (tx, row) => {
        const executor = tx as unknown as OutboxRawExecutor;
        await this.audit.emit(executor, input.audit, {
          action: 'trust_safety_incident:resolve',
          resourceKind: TRUST_SAFETY_AUDIT_RESOURCE.incident,
          resourceId: row.id,
          before: { status: before.status, resolvedAt: null },
          // `resolutionNotes` is deliberately absent from both snapshots —
          // free text about a named senior, same PHI reasoning as the
          // mandated-reporter case snapshots (CLAUDE.md §3.9).
          after: { status: row.status, resolvedAt: row.resolvedAt?.toISOString() ?? null },
        });
        // TS-304 — lift the booking hold in the same transaction that closes
        // the incident. Ordering is deliberate: the audit event is appended
        // first, so if the release append fails the whole resolution rolls
        // back and there is no audit record claiming a closure that did not
        // happen. A no-op for incidents that never held anything.
        await this.bookingHold.emitHoldReleased(executor, row, now);
      },
    );

    if (resolved === null) {
      throw new ConflictException({
        type: 'about:blank',
        title: 'Conflict',
        status: 409,
        detail: 'incident is already resolved',
      });
    }

    this.logger.log(
      `trust_safety.incident.resolved ${JSON.stringify({
        incidentId: resolved.id,
        category: resolved.category,
        severity: resolved.severity,
        resolvedAt: resolved.resolvedAt?.toISOString() ?? null,
        actorUserId: input.audit.actorUserId,
      })}`,
    );

    return resolved;
  }

  async getIncident(id: string): Promise<IncidentRow> {
    const incident = await this.incidents.findById(id);
    if (incident === null) throw incidentNotFound();
    return incident;
  }

  /**
   * The operator queue (TS-303c2d). `status` absent means every unresolved
   * incident — the queue is live work.
   */
  async listIncidents(filter: ListIncidentsFilter): Promise<IncidentSummaryRow[]> {
    return this.incidents.list(filter);
  }

  /**
   * One incident with its free text and the statutory-pathway flag. Separate
   * from `getIncident` because that seam is the internal one (used by the
   * resolution flow); this is the authorised ops READ, and its extra field
   * exists so the detail surface can say "this cannot be closed" without a
   * second round-trip.
   */
  async getIncidentDetail(id: string): Promise<IncidentDetailRow> {
    const incident = await this.incidents.findDetailById(id);
    if (incident === null) throw incidentNotFound();
    return incident;
  }
}

function incidentNotFound(): NotFoundException {
  return new NotFoundException({
    type: 'about:blank',
    title: 'Not Found',
    status: 404,
    detail: 'incident not found',
  });
}
