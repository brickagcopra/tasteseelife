import { Module } from '@nestjs/common';

import { MandatedReporterModule } from '../mandated-reporter/mandated-reporter.module';
import { AdminIncidentResolutionController } from './controllers/admin-incident-resolution.controller';
import { AdminIncidentsReadController } from './controllers/admin-incidents-read.controller';
import { AdminReportConcernController } from './controllers/admin-report-concern.controller';
import { ReportConcernController } from './controllers/report-concern.controller';
import { BookingHoldEmitter } from './booking-hold-emitter';
import { IncidentCreatedEmitter } from './incident-created-emitter';
import { IncidentRepository } from './repositories/incident.repository';
import { IncidentPagerMetrics } from './services/incident-pager-metrics';
import { IncidentPagerService } from './services/incident-pager.service';
import { IncidentsMetrics } from './services/incidents-metrics';
import { IncidentsService } from './services/incidents.service';
import { SlaBreachMetrics } from './services/sla-breach-metrics';
import { SlaBreachRunner } from './sla-breach.runner';
import { SlaBreachSweepService } from './services/sla-breach-sweep.service';

/**
 * The incidents module. TS-300 shipped the internal seam (create/get with
 * SLA computation at insert); TS-301a added the first authenticated HTTP
 * surface — `ReportConcernController` (`POST /api/v1/trust-safety/incidents`,
 * the family/senior "Report a concern" intake) — plus the
 * `IncidentCreatedEmitter` appending `trust_safety.incident.created` inside
 * the insert transaction. TS-301b widened that route to admit provider
 * filers and added `AdminReportConcernController`
 * (`POST /api/v1/admin/trust-safety/incidents`) for the concierge on-behalf
 * path — a separate route because a body-supplied household id is an
 * authorisation decision gated on `concierge:write`. The TS-302 escalation
 * consumers inject the same exported `IncidentsService` seam when they land.
 *
 * TS-303b added `AdminIncidentResolutionController` — the first and only path
 * that closes an incident. It imports `MandatedReporterModule` for one
 * reason: `IncidentsService.resolveIncident` consults
 * `assertIncidentResolvable` before writing, which is what turns CLAUDE.md
 * §12's never-auto-close rule from a comment into a 409. The dependency runs
 * one way (incidents → mandated-reporter), so there is no cycle.
 *
 * TS-303c2d added `AdminIncidentsReadController`, the first surface that can
 * READ an incident over HTTP — until it landed, the partial SLA index TS-300
 * built for the operator queue had no reader and nothing could navigate from
 * an incident to opening a mandated-reporter case on it.
 *
 * TS-304 added `BookingHoldEmitter` — a second in-tx producer on the same
 * insert seam, plus the first one on the resolve seam. It publishes the
 * `trust_safety.booking_hold.requested` / `.released` pair that suspends and
 * lifts a subject's bookings while a `high` / `critical` concern is under
 * review. The eligibility predicate lives in `booking-hold-policy.ts` on
 * THIS side of the wire: service-booking applies an explicit hold order and
 * never re-derives it from a severity.
 */
@Module({
  imports: [MandatedReporterModule],
  controllers: [
    ReportConcernController,
    AdminReportConcernController,
    AdminIncidentResolutionController,
    // TS-303c2d — the service's first incident READ surface: the operator
    // queue (gated `trust_safety:read`) and the incident detail (gated
    // `trust_safety:write`, because it carries the filer's free text).
    AdminIncidentsReadController,
  ],
  providers: [
    IncidentRepository,
    IncidentsService,
    IncidentCreatedEmitter,
    // TS-304 — the booking-hold pair. A no-op for incidents below `high` or
    // naming no subject, so the `IncidentsService` call sites are
    // unconditional and a future insert path inherits the behaviour.
    BookingHoldEmitter,
    // TS-306 — on-call paging for `critical` incidents. `PagerDutyClient`
    // comes from the `@Global()` `PagerDutyModule.forRoot(...)` in AppModule.
    IncidentPagerService,
    // TS-306-followup-1c — the service's first domain instruments, now that
    // `ObservabilityModule` + the `main.ts` bootstrap give them a real meter
    // provider to report to. Three separate classes because they answer
    // three separate operational questions (what is arriving / did anyone
    // get woken / what is going stale) and are injected by three different
    // collaborators. Constructing one is free and side-effect-less, so they
    // need no test doubles.
    IncidentsMetrics,
    IncidentPagerMetrics,
    SlaBreachMetrics,
    // TS-306-followup-1a — the SLA-BREACH sweep, this service's first
    // BullMQ queue. A different signal from the pager above: that one
    // fires when something critical arrives, this one when something has
    // been sitting past its deadline. It deliberately does NOT page —
    // see the runner's doc-block. `BullMqSchedulerService` comes from the
    // `@Global()` scheduler module in AppModule.
    SlaBreachSweepService,
    SlaBreachRunner,
  ],
  exports: [IncidentsService],
})
export class IncidentsModule {}
