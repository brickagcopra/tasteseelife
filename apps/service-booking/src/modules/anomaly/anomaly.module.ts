import { Module } from '@nestjs/common';

import { AnomalySweepRunner } from './anomaly-sweep.runner';
import { ImpossibleTravelDetectorService } from './impossible-travel-detector.service';
import { MassCancellationDetectorService } from './mass-cancellation-detector.service';

/**
 * Anomaly detection (TS-308a, TS-308c; PRD §10.13, PDD §17.3).
 *
 * Composition:
 *   - `ImpossibleTravelDetectorService` — provider check-ins further
 *     apart than the elapsed time allows: scan, judge, emit.
 *   - `MassCancellationDetectorService` — one subject accumulating an
 *     unusual number of cancellation decisions in a rolling window.
 *   - `AnomalySweepRunner` — service-booking's first BullMQ queue,
 *     driving BOTH detectors on one repeatable schedule. A second timer
 *     would double the scheduler state and the operational surface for
 *     two questions that want the same cadence.
 *
 * The queue itself comes from `BullMqSchedulerService`
 * (`@taste-and-see/nest-bullmq-scheduler`, `@Global()` — hence no import
 * line here), which since TS-308a-followup-1 owns the connection, the
 * §3.7 prefix and the shutdown drain, and keeps the real BullMQ handles
 * behind an injectable factory so unit tests never open Redis
 * connections.
 *
 * **No controller.** Nothing about this is a request. The findings reach
 * a human as trust & safety incidents (TS-307a's event → consumer →
 * incident path), which is where the review queue, the SLA clock and the
 * audit trail already are — an endpoint here would be a second, worse
 * place to look at safety events.
 *
 * `PrismaService` and `OutboxService` come from their global modules.
 * Exports nothing: the sweep has one caller and it is inside this
 * module.
 */
@Module({
  providers: [ImpossibleTravelDetectorService, MassCancellationDetectorService, AnomalySweepRunner],
})
export class AnomalyModule {}
