import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  InternalSeniorWellnessObservationSummaryResponse,
  WellnessSummaryHousehold,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { DispatchClient } from './clients/dispatch.client';
import { HouseholdsClient } from './clients/households.client';
import { ObservationSummaryClient } from './clients/observation-summary.client';
import { RecipientContactsClient } from './clients/recipient-contacts.client';
import type { ResolvedPeriod } from './schedule';
import { buildDispatchRequest } from './variable-builder';

/**
 * Tally of one monthly run. Every counter is best-effort: a failing
 * household / senior / recipient is logged + skipped, never aborts the
 * run (a single unreachable senior shouldn't deny every other family
 * their summary).
 */
export interface RunReport {
  householdsProcessed: number;
  householdsSkipped: number;
  seniorsSummarised: number;
  seniorsSkipped: number;
  dispatchesSent: number;
  dispatchesSuppressed: number;
  dispatchesReplayed: number;
  dispatchesFailed: number;
  recipientsSkipped: number;
}

/**
 * The monthly wellness-summary run (TS-235; PRD §6.9).
 *
 * Walks the active household population page-by-page, and for each
 * household: resolves recipient emails (service-identity), fetches each
 * senior's observation roll-up (service-booking), then dispatches one
 * rendered summary email per `(senior × active recipient)` through
 * service-notification with a deterministic idempotency key.
 *
 * **Concurrency.** Households are processed sequentially; within a
 * household, senior observations are fetched in parallel, but dispatches
 * are issued sequentially to keep a bounded, gentle load on
 * service-notification. The bounded shape is deliberate — this is a
 * once-a-month batch, not a latency-sensitive path.
 */
@Injectable()
export class SummaryOrchestratorService {
  private readonly logger = new Logger(SummaryOrchestratorService.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly households: HouseholdsClient,
    private readonly contacts: RecipientContactsClient,
    private readonly observations: ObservationSummaryClient,
    private readonly dispatch: DispatchClient,
  ) {}

  async runForPeriod(period: ResolvedPeriod): Promise<RunReport> {
    const report: RunReport = {
      householdsProcessed: 0,
      householdsSkipped: 0,
      seniorsSummarised: 0,
      seniorsSkipped: 0,
      dispatchesSent: 0,
      dispatchesSuppressed: 0,
      dispatchesReplayed: 0,
      dispatchesFailed: 0,
      recipientsSkipped: 0,
    };

    this.logger.log({ period: period.periodKey }, 'wellness-summary run starting');

    let cursor: string | undefined;
    do {
      const page = await this.households.fetchPage(
        cursor,
        this.env.WELLNESS_SUMMARY_HOUSEHOLD_PAGE_LIMIT,
      );
      for (const household of page.households) {
        await this.processHousehold(household, period, report);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    this.logger.log({ period: period.periodKey, ...report }, 'wellness-summary run complete');
    return report;
  }

  private async processHousehold(
    household: WellnessSummaryHousehold,
    period: ResolvedPeriod,
    report: RunReport,
  ): Promise<void> {
    // Resolve recipient emails. A failure here means we can't address
    // anyone in the household — skip it (the next run retries).
    let contactsByUserId: Awaited<ReturnType<RecipientContactsClient['resolve']>>;
    try {
      contactsByUserId = await this.contacts.resolve(household.recipients.map((r) => r.userId));
    } catch (err) {
      report.householdsSkipped += 1;
      this.logger.warn(
        { householdId: household.householdId, err: errMessage(err) },
        'skipping household: recipient-contact resolution failed',
      );
      return;
    }

    // Fetch each senior's observation roll-up in parallel; a failed
    // senior is dropped from the map (its recipients get no email this
    // run rather than blocking the rest of the household).
    const observationBySenior = new Map<string, InternalSeniorWellnessObservationSummaryResponse>();
    await Promise.all(
      household.seniors.map(async (senior) => {
        try {
          const summary = await this.observations.fetch(
            household.householdId,
            senior.seniorId,
            this.env.WELLNESS_SUMMARY_WINDOW_DAYS as 30 | 90,
          );
          observationBySenior.set(senior.seniorId, summary);
        } catch (err) {
          report.seniorsSkipped += 1;
          this.logger.warn(
            { householdId: household.householdId, seniorId: senior.seniorId, err: errMessage(err) },
            'skipping senior: observation summary fetch failed',
          );
        }
      }),
    );

    for (const senior of household.seniors) {
      const observation = observationBySenior.get(senior.seniorId);
      if (observation === undefined) continue; // already counted in seniorsSkipped
      report.seniorsSummarised += 1;

      for (const recipient of household.recipients) {
        const contact = contactsByUserId.get(recipient.userId);
        if (contact === undefined || contact.status !== 'active') {
          report.recipientsSkipped += 1;
          continue;
        }
        await this.dispatchOne(
          household,
          senior,
          recipient,
          contact.email,
          observation,
          period,
          report,
        );
      }
    }

    report.householdsProcessed += 1;
  }

  private async dispatchOne(
    household: WellnessSummaryHousehold,
    senior: WellnessSummaryHousehold['seniors'][number],
    recipient: WellnessSummaryHousehold['recipients'][number],
    recipientEmail: string,
    observation: InternalSeniorWellnessObservationSummaryResponse,
    period: ResolvedPeriod,
    report: RunReport,
  ): Promise<void> {
    const body = buildDispatchRequest({
      recipient,
      recipientEmail,
      senior,
      observation,
      periodKey: period.periodKey,
      periodLabel: period.periodLabel,
      appName: this.env.WELLNESS_SUMMARY_APP_NAME,
    });

    try {
      const result = await this.dispatch.dispatch(body);
      if (result.replayed) {
        report.dispatchesReplayed += 1;
      } else if (result.status === 'sent' || result.status === 'queued') {
        report.dispatchesSent += 1;
      } else {
        report.dispatchesSuppressed += 1;
      }
    } catch (err) {
      report.dispatchesFailed += 1;
      this.logger.warn(
        {
          householdId: household.householdId,
          seniorId: senior.seniorId,
          recipientUserId: recipient.userId,
          err: errMessage(err),
        },
        'dispatch failed for recipient',
      );
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
