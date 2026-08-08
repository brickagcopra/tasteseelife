import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { CertificationRenewalCandidate, RecipientContact } from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

import { DispatchClient } from './clients/dispatch.client';
import { ExpireClient } from './clients/expire.client';
import { RecipientContactsClient } from './clients/recipient-contacts.client';
import { RenewalsClient } from './clients/renewals.client';
import { buildReminderDispatch } from './reminder-builder';
import { classifyRenewalCandidate, type ResolvedPeriod } from './schedule';

/**
 * Tally of one daily run. Every counter is best-effort: a failing
 * page / certification / recipient is logged + skipped, never aborts the
 * run (a single unreachable certification shouldn't deny every other
 * holder their reminder, or block every other lapse from being recorded).
 */
export interface RunReport {
  candidatesScanned: number;
  certificationsExpired: number;
  expireNoOp: number;
  expireFailed: number;
  remindersSent: number;
  remindersReplayed: number;
  remindersSuppressed: number;
  remindersFailed: number;
  recipientsSkipped: number;
  skipped: number;
}

/**
 * The daily certification-renewal run (TS-256; PRD §9.3; PDD §15.2).
 *
 * Walks the at-risk certification population page-by-page. For each
 * candidate it classifies against the clock:
 *   - lapsed   → issue the idempotent `expire` write (active → expired);
 *   - reminder → resolve the holder's email (service-identity) + dispatch
 *                the 90/60/30/7-day milestone email (service-notification)
 *                with a deterministic idempotency key;
 *   - skip     → no action this run.
 *
 * **Concurrency.** Pages are processed sequentially; within a page, the
 * recipient emails for the reminder candidates are resolved in ONE batch,
 * then expires + dispatches are issued sequentially to keep a bounded,
 * gentle load on the upstreams. This is a once-a-day batch, not a
 * latency-sensitive path.
 */
@Injectable()
export class RenewalOrchestratorService {
  private readonly logger = new Logger(RenewalOrchestratorService.name);

  constructor(
    @Inject(ENV_TOKEN) private readonly env: Env,
    private readonly renewals: RenewalsClient,
    private readonly contacts: RecipientContactsClient,
    private readonly expireClient: ExpireClient,
    private readonly dispatch: DispatchClient,
    /**
     * Injected clock, for the period-resolution tests.
     *
     * **`@Optional()` is load-bearing and its absence made this worker
     * unbootable.** A default value does not stop Nest injecting a parameter:
     * it reads `design:paramtypes`, sees `Function`, finds no provider, and
     * throws `UnknownDependenciesException` at bootstrap — so the process
     * exited 1 before it ever listened. Nothing caught it: vitest/esbuild
     * emits no `design:paramtypes`, so the unit suite (which constructs this
     * class directly anyway) is blind to it, TS-506's boot-graph guard shares
     * that blindness, and TS-500's runtime boot sweep covered the 20 services
     * but never ran the 9 workers. Found by the TS-505 boot sweep.
     *
     * Same defect as the four sites TS-506 fixed in service-academy. Note the
     * `metrics: XMetrics = new XMetrics()` pattern elsewhere is fine — a class
     * token resolves; only function-typed defaults break.
     */
    @Optional() private readonly now: () => Date = () => new Date(),
  ) {}

  async runForPeriod(period: ResolvedPeriod): Promise<RunReport> {
    const report: RunReport = {
      candidatesScanned: 0,
      certificationsExpired: 0,
      expireNoOp: 0,
      expireFailed: 0,
      remindersSent: 0,
      remindersReplayed: 0,
      remindersSuppressed: 0,
      remindersFailed: 0,
      recipientsSkipped: 0,
      skipped: 0,
    };

    this.logger.log({ period: period.periodKey }, 'certification-renewal run starting');

    let cursor: string | undefined;
    do {
      let page: Awaited<ReturnType<RenewalsClient['fetchPage']>>;
      try {
        page = await this.renewals.fetchPage(
          cursor,
          this.env.CERTIFICATION_RENEWAL_PAGE_LIMIT,
          this.env.CERTIFICATION_RENEWAL_HORIZON_DAYS,
        );
      } catch (err) {
        // A failed page read aborts the walk (we can't get a cursor to
        // continue) — the next daily run retries from the top.
        this.logger.error(
          { period: period.periodKey, cursor: cursor ?? null, err: errMessage(err) },
          'certification-renewal run aborted: renewals page fetch failed',
        );
        break;
      }

      await this.processPage(page.certifications, report);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);

    this.logger.log({ period: period.periodKey, ...report }, 'certification-renewal run complete');
    return report;
  }

  private async processPage(
    candidates: readonly CertificationRenewalCandidate[],
    report: RunReport,
  ): Promise<void> {
    const now = this.now();
    const reminders: Array<{
      candidate: CertificationRenewalCandidate;
      daysUntilExpiry: number;
      milestoneDays: 90 | 60 | 30 | 7;
    }> = [];

    // First pass: classify. Lapsed certifications are expired immediately
    // (no recipient resolution needed); reminder candidates are collected
    // so their emails resolve in one batch.
    for (const candidate of candidates) {
      report.candidatesScanned += 1;
      const classification = classifyRenewalCandidate(candidate.expiresAt, now);

      if (classification.kind === 'lapsed') {
        await this.expireOne(candidate, report);
        continue;
      }
      if (classification.kind === 'skip') {
        report.skipped += 1;
        continue;
      }
      reminders.push({
        candidate,
        daysUntilExpiry: classification.daysUntilExpiry,
        milestoneDays: classification.milestoneDays,
      });
    }

    if (reminders.length === 0) return;

    // Resolve every reminder recipient's email in one batch. A failure
    // means we can't address anyone this page — skip the reminders (the
    // next run retries); the lapses already recorded above stand.
    let contactsByUserId: Map<string, RecipientContact>;
    try {
      contactsByUserId = await this.contacts.resolve(
        reminders.map((r) => r.candidate.studentUserId),
      );
    } catch (err) {
      report.recipientsSkipped += reminders.length;
      this.logger.warn(
        { count: reminders.length, err: errMessage(err) },
        'skipping page reminders: recipient-contact resolution failed',
      );
      return;
    }

    for (const reminder of reminders) {
      const contact = contactsByUserId.get(reminder.candidate.studentUserId);
      if (contact === undefined || contact.status !== 'active') {
        report.recipientsSkipped += 1;
        continue;
      }
      await this.dispatchOne(reminder, contact.email, report);
    }
  }

  private async expireOne(
    candidate: CertificationRenewalCandidate,
    report: RunReport,
  ): Promise<void> {
    try {
      const result = await this.expireClient.expire(candidate.certificationId);
      if (result.changed) {
        report.certificationsExpired += 1;
        // The lapse flip is the "course.completed reversal" trigger point
        // (PRD §9.3). The downstream provider-tier demotion is the deferred
        // TS-256-followup-1 (service-academy has no outbox yet).
        this.logger.log(
          { certificationId: candidate.certificationId },
          'certification lapsed → expired',
        );
      } else {
        report.expireNoOp += 1;
      }
    } catch (err) {
      report.expireFailed += 1;
      this.logger.warn(
        { certificationId: candidate.certificationId, err: errMessage(err) },
        'expire failed for lapsed certification',
      );
    }
  }

  private async dispatchOne(
    reminder: {
      candidate: CertificationRenewalCandidate;
      daysUntilExpiry: number;
      milestoneDays: 90 | 60 | 30 | 7;
    },
    recipientEmail: string,
    report: RunReport,
  ): Promise<void> {
    const body = buildReminderDispatch({
      candidate: reminder.candidate,
      recipientEmail,
      daysUntilExpiry: reminder.daysUntilExpiry,
      milestoneDays: reminder.milestoneDays,
      renewUrl: this.env.CERTIFICATION_RENEWAL_RENEW_URL,
      appName: this.env.CERTIFICATION_RENEWAL_APP_NAME,
    });

    try {
      const result = await this.dispatch.dispatch(body);
      if (result.replayed) {
        report.remindersReplayed += 1;
      } else if (result.status === 'sent' || result.status === 'queued') {
        report.remindersSent += 1;
      } else {
        report.remindersSuppressed += 1;
      }
    } catch (err) {
      report.remindersFailed += 1;
      this.logger.warn(
        {
          certificationId: reminder.candidate.certificationId,
          milestoneDays: reminder.milestoneDays,
          err: errMessage(err),
        },
        'dispatch failed for renewal reminder',
      );
    }
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
