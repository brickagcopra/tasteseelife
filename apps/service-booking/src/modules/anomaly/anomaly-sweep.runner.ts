import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { BullMqSchedulerService } from '@taste-and-see/nest-bullmq-scheduler';

import { ENV_TOKEN } from '../../config/config.module';
import type { Env } from '../../config/env';

import { ImpossibleTravelDetectorService } from './impossible-travel-detector.service';
import { MassCancellationDetectorService } from './mass-cancellation-detector.service';

export const ANOMALY_SWEEP_QUEUE_NAME = 'booking-anomaly-sweep';
export const ANOMALY_SWEEP_SCHEDULER_ID = 'booking-anomaly-sweep';

/**
 * Scheduling half of the anomaly detection sweep (TS-308a, TS-308c).
 *
 * **One queue, one timer, N detectors.** TS-308c added mass-cancellation
 * detection to this sweep rather than standing up a second scheduler:
 * both are "scan a recent window of booking rows and emit findings", the
 * cadence that suits one suits the other, and a second repeatable job
 * would double the Redis scheduler state and the operational surface for
 * no gain. Each detector keeps its own window, thresholds and kill
 * switch, because the questions are unrelated.
 *
 * The queue + worker lifecycle, the Redis connection decomposition, the
 * CLAUDE.md §3.7 key prefix and the shutdown drain all moved to
 * `@taste-and-see/nest-bullmq-scheduler` at TS-308a-followup-1 — that
 * skeleton was verbatim here and in service-identity's rbac-revoker, and
 * the third copy (TS-309a-followup-2) triggered the extraction. The sweep
 * still runs INSIDE service-booking rather than in a standalone worker
 * app, for the TS-293 reason: it needs booking's own Prisma client, and a
 * worker app would either breach CLAUDE.md §2.3 (cross-service DB access)
 * or need an internal bulk-scan API with no other caller.
 *
 * Disabled via `BOOKING_ANOMALY_DETECTION_ENABLED=false`, which creates
 * no queue and no worker at all. That is a real operational need, not a
 * test affordance: if a mis-tuned threshold starts filling the trust &
 * safety queue, ops turns it off with an env change rather than a
 * redeploy.
 *
 * Observability per CLAUDE.md §10: the shared scheduler logs the arm (with
 * every configured window and threshold echoed on the line) and any
 * BullMQ-level job failure; each detector logs its own counts.
 */
@Injectable()
export class AnomalySweepRunner implements OnModuleInit {
  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    @Inject(BullMqSchedulerService) private readonly scheduler: BullMqSchedulerService,
    private readonly detector: ImpossibleTravelDetectorService,
    private readonly massCancellation: MassCancellationDetectorService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.scheduler.schedule({
      queueName: ANOMALY_SWEEP_QUEUE_NAME,
      schedulerId: ANOMALY_SWEEP_SCHEDULER_ID,
      intervalMs: this.env.BOOKING_ANOMALY_SWEEP_INTERVAL_MS,
      enabled: this.env.BOOKING_ANOMALY_DETECTION_ENABLED,
      disabledBy: 'BOOKING_ANOMALY_DETECTION_ENABLED',
      processor: () => this.runSweep(),
      details: {
        lookbackHours: this.env.BOOKING_ANOMALY_LOOKBACK_HOURS,
        maxSpeedKph: this.env.BOOKING_ANOMALY_MAX_SPEED_KPH,
        massCancellationEnabled: this.env.BOOKING_MASS_CANCELLATION_ENABLED,
        massCancellationWindowHours: this.env.BOOKING_MASS_CANCELLATION_WINDOW_HOURS,
        massCancellationProviderThreshold: this.env.BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD,
        massCancellationHouseholdThreshold: this.env.BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD,
      },
    });
  }

  /**
   * One tick, running every enabled detector.
   *
   * **Each detector runs even if an earlier one threw**, and a throw is
   * re-raised only after all of them have had their turn. They are
   * independent questions over independent tables, and letting a
   * database blip in the check-in scan silently cost the platform its
   * cancellation detection — with nothing in the logs to say a detector
   * was skipped rather than clean — is exactly the quiet failure this
   * whole track exists to avoid. Errors are aggregated so BullMQ still
   * marks the job failed and the scheduler still logs it; the repeatable
   * definition keeps its next tick either way, so a transient failure
   * costs one sweep, not the detector.
   */
  async runSweep(now: Date = new Date()): Promise<void> {
    const failures: Error[] = [];

    try {
      await this.detector.sweep({
        now,
        lookbackHours: this.env.BOOKING_ANOMALY_LOOKBACK_HOURS,
        maxSpeedKph: this.env.BOOKING_ANOMALY_MAX_SPEED_KPH,
      });
    } catch (error) {
      failures.push(asError(error));
    }

    if (this.env.BOOKING_MASS_CANCELLATION_ENABLED) {
      try {
        await this.massCancellation.sweep({
          now,
          windowHours: this.env.BOOKING_MASS_CANCELLATION_WINDOW_HOURS,
          thresholds: {
            provider: this.env.BOOKING_MASS_CANCELLATION_PROVIDER_THRESHOLD,
            household: this.env.BOOKING_MASS_CANCELLATION_HOUSEHOLD_THRESHOLD,
          },
        });
      } catch (error) {
        failures.push(asError(error));
      }
    }

    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new Error(`booking-anomaly sweep: ${failures.map((f) => f.message).join('; ')}`);
    }
  }
}

/** Narrow an unknown throw to an `Error` without losing its message. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
