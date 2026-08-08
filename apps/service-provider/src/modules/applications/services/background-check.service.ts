import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import {
  ApplicationsMetrics,
  applyWebhookOutcome,
  normalizeCheckrEventTypeLabel,
  type ProviderBackgroundCheckWebhookOutcome,
} from './applications-metrics';
import { AdverseFindingEmitter } from './adverse-finding-emitter';
import type { ProviderRecordStatus } from './adverse-finding-policy';
import { BackgroundCheckPayloadCipherService } from './background-check-payload-cipher.service';
import { CheckrClient, type CheckrFailure, type CreateCandidateInput } from './checkr.client';
import { err, ok, type Result } from './result';

/**
 * Local mirror of the Prisma-generated `BackgroundCheckStatus` enum.
 * Same TS-021-followup-2 / TS-021-followup-3 root cause —
 * `@prisma/client`'s namespace exports of enum *values* resolve
 * inconsistently under our `verbatimModuleSyntax: false` /
 * `isolatedModules: true` tsconfig. Drift between this union and the
 * Prisma schema would surface at the first call that passes a
 * non-listed string to Prisma; the test suite cross-pins by
 * asserting each status path.
 */
export type BackgroundCheckRecordStatus =
  | 'pending'
  | 'processing'
  | 'clear'
  | 'consider'
  | 'suspended'
  | 'engaged'
  | 'dispute'
  | 'canceled'
  | 'failed';

/**
 * Local mirror of the Prisma-generated `ProviderBackgroundCheck`
 * row shape. Kept narrow to what this service reads / writes —
 * adding a column to `schema.prisma` requires extending this
 * interface too.
 */
export interface BackgroundCheckRecord {
  readonly id: string;
  readonly providerId: string;
  readonly applicationId: string | null;
  readonly status: BackgroundCheckRecordStatus;
  readonly checkrCandidateId: string;
  readonly checkrReportId: string | null;
  readonly lastEventId: string | null;
  readonly completedAt: Date | null;
  readonly payloadCiphertext: Buffer | null;
  readonly payloadIv: Buffer | null;
  readonly payloadAuthTag: Buffer | null;
  readonly payloadKeyVersion: number | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Failure shapes returned by `BackgroundCheckService`. Modelled as a
 * discriminated union so the controller's `throwFailure` switch is
 * exhaustive (CLAUDE.md §2.1).
 */
export type BackgroundCheckServiceFailure =
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'record_not_found' }
  | { readonly reason: 'report_mismatch'; readonly reportId: string }
  | { readonly reason: 'event_replay'; readonly eventId: string }
  | { readonly reason: 'checkr_unavailable'; readonly cause: unknown }
  | { readonly reason: 'checkr_invalid_applicant'; readonly message: string };

export interface StartCheckInput {
  readonly providerId: string;
  readonly applicationId: string;
  readonly applicant: CreateCandidateInput;
  /**
   * Optional Idempotency-Key forwarded both to our local replay
   * cache and to Checkr's `Idempotency-Key` header so a retried
   * POST that crashed mid-flight returns the same Checkr candidate
   * / report rather than creating duplicates.
   */
  readonly idempotencyKey?: string;
}

export interface ApplyWebhookEventInput {
  /** Checkr `event.id`. Used for idempotency. */
  readonly eventId: string;
  /** Checkr `event.type` (e.g. `report.completed`). Logged. */
  readonly eventType: string;
  /** Checkr `event.created_at` in Unix seconds. */
  readonly eventCreatedSeconds: number;
  /**
   * Projection of Checkr's `report` object.
   */
  readonly report: {
    readonly id: string;
    readonly candidateId: string;
    readonly status: string;
  };
  /**
   * JSON-stringified raw Checkr event. Encrypted at rest via
   * `BackgroundCheckPayloadCipherService`.
   */
  readonly rawPayload: string;
}

/**
 * `BackgroundCheckService` — owns the Checkr lifecycle for
 * service-provider.
 *
 * Two write paths:
 *
 *   1. `startCheck({ providerId, applicationId, applicant })` —
 *      creates a Checkr candidate + report, persists a `pending` (or
 *      Checkr-reported) row keyed on the opaque candidate id. PII
 *      from the applicant goes to Checkr directly; only the candidate
 *      id is persisted on our side.
 *
 *   2. `applyWebhookEvent(...)` — invoked by the controller's
 *      internal dispatch route once service-webhook delivers a
 *      `report.*` Checkr event. Idempotent on `event.id`
 *      (short-circuits if the row's `lastEventId` already matches);
 *      updates the row's status, completedAt, and encrypts +
 *      persists the latest Checkr payload.
 *
 * One read path:
 *
 *   3. `getLatestForProvider(providerId)` — returns the most-recent
 *      check for the provider, or null when none exists. The
 *      controller projects this to the contract DTO.
 *
 * **No PII in logs.** We log the providerId, candidateId,
 * reportId, status, and eventId. We never log the Stripe / Checkr
 * payload — the encrypted column is the only durable copy
 * (CLAUDE.md §3.9).
 */
@Injectable()
export class BackgroundCheckService {
  private readonly logger = new Logger(BackgroundCheckService.name);
  private readonly packageSlug: string;
  private readonly workLocationStates: readonly string[];

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkr: CheckrClient,
    private readonly cipher: BackgroundCheckPayloadCipherService,
    private readonly adverseFinding: AdverseFindingEmitter,
    @Inject(ENV_TOKEN) env: Env,
    // Optional default (TS-051-followup-7) — keeps the four-arg unit-test
    // call sites working; Nest injects the registered provider in prod.
    private readonly metrics: ApplicationsMetrics = new ApplicationsMetrics(),
  ) {
    this.packageSlug = env.CHECKR_DEFAULT_PACKAGE;
    this.workLocationStates = parseStateList(env.CHECKR_DEFAULT_WORK_LOCATION_STATES);
  }

  async startCheck(
    input: StartCheckInput,
  ): Promise<Result<BackgroundCheckRecord, BackgroundCheckServiceFailure>> {
    if (input.providerId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId is required' });
    }
    if (input.applicationId.length === 0) {
      return err({ reason: 'invalid_request', message: 'applicationId is required' });
    }

    const candidateResult = await this.checkr.createCandidate({
      ...input.applicant,
      ...(input.idempotencyKey !== undefined && {
        idempotencyKey: `checkr-candidate:${input.idempotencyKey}`,
      }),
    });
    if (!candidateResult.ok) {
      return err(checkrFailureToServiceFailure(candidateResult.error));
    }

    const reportResult = await this.checkr.createReport({
      candidateId: candidateResult.value.id,
      packageSlug: this.packageSlug,
      workLocationStates: this.workLocationStates,
      ...(input.idempotencyKey !== undefined && {
        idempotencyKey: `checkr-report:${input.idempotencyKey}`,
      }),
    });
    if (!reportResult.ok) {
      return err(checkrFailureToServiceFailure(reportResult.error));
    }

    const mappedStatus = mapCheckrStatusString(reportResult.value.status);

    const row = (await this.prisma.providerBackgroundCheck.create({
      data: {
        providerId: input.providerId,
        applicationId: input.applicationId,
        status: mappedStatus,
        checkrCandidateId: candidateResult.value.id,
        checkrReportId: reportResult.value.id,
      },
    })) as BackgroundCheckRecord;

    this.logger.log(
      {
        providerId: input.providerId,
        applicationId: input.applicationId,
        candidateId: candidateResult.value.id,
        reportId: reportResult.value.id,
        status: row.status,
      },
      'backgroundCheck.start ok',
    );
    return ok(row);
  }

  async getLatestForProvider(providerId: string): Promise<BackgroundCheckRecord | null> {
    if (providerId.length === 0) return null;
    const row = (await this.prisma.providerBackgroundCheck.findFirst({
      where: { providerId },
      orderBy: { createdAt: 'desc' },
    })) as BackgroundCheckRecord | null;
    return row;
  }

  async applyWebhookEvent(
    input: ApplyWebhookEventInput,
  ): Promise<Result<BackgroundCheckRecord, BackgroundCheckServiceFailure>> {
    return withSpan('provider.background_check.apply_webhook', async (span) => {
      const startNs = process.hrtime.bigint();
      // Default to `error` so an unexpected throw (e.g. a Prisma update
      // failure, a cipher error) records a bounded outcome rather than
      // mislabelling the sample as a success.
      let outcome: ProviderBackgroundCheckWebhookOutcome = 'error';
      try {
        const result = await this.runApplyWebhookEvent(input);
        outcome = result.ok ? 'applied' : applyWebhookOutcome(result.error);
        return result;
      } finally {
        const seconds = Number(process.hrtime.bigint() - startNs) / 1e9;
        span.setAttribute(
          'provider.background_check.event_type',
          normalizeCheckrEventTypeLabel(input.eventType),
        );
        span.setAttribute('provider.background_check.outcome', outcome);
        this.metrics.recordWebhookApplied(input.eventType, outcome, seconds);
      }
    });
  }

  private async runApplyWebhookEvent(
    input: ApplyWebhookEventInput,
  ): Promise<Result<BackgroundCheckRecord, BackgroundCheckServiceFailure>> {
    if (input.eventId.length === 0) {
      return err({ reason: 'invalid_request', message: 'eventId is required' });
    }
    if (input.report.id.length === 0) {
      return err({ reason: 'invalid_request', message: 'report.id is required' });
    }

    const row = (await this.prisma.providerBackgroundCheck.findUnique({
      where: { checkrReportId: input.report.id },
    })) as BackgroundCheckRecord | null;
    if (row === null) {
      // The report was created outside our system (manual operator
      // action in the Checkr dashboard; an orphaned candidate). The
      // dispatcher logs the miss and stops retrying.
      this.logger.warn(
        { reportId: input.report.id, eventId: input.eventId },
        'backgroundCheck.applyWebhookEvent: no local row for report',
      );
      return err({ reason: 'report_mismatch', reportId: input.report.id });
    }
    if (row.lastEventId === input.eventId) {
      // Idempotent replay — the dispatcher resent an event we
      // already applied. Surface as event_replay so the controller
      // returns outcome=replayed.
      this.logger.debug(
        { reportId: input.report.id, eventId: input.eventId, checkId: row.id },
        'backgroundCheck.applyWebhookEvent: replay (already applied)',
      );
      return err({ reason: 'event_replay', eventId: input.eventId });
    }

    const nextStatus = mapCheckrStatusString(input.report.status);
    const encrypted = this.cipher.encrypt(input.rawPayload);

    // Local update shape mirrors the columns this service writes.
    // Avoids importing Prisma's namespace-resolved
    // `ProviderBackgroundCheckUncheckedUpdateInput` (same
    // TS-021-followup-2/3 root cause). Prisma accepts this shape
    // structurally at runtime.
    const update: Record<string, unknown> = {
      status: nextStatus,
      payloadCiphertext: encrypted.ciphertext,
      payloadIv: encrypted.iv,
      payloadAuthTag: encrypted.authTag,
      payloadKeyVersion: encrypted.keyVersion,
      lastEventId: input.eventId,
    };
    // Set completedAt exactly once — on the transition into a
    // terminal status from a non-terminal state. Preserve the
    // existing completedAt if Checkr redelivers the terminal event.
    if (isTerminalStatus(nextStatus) && !isTerminalStatus(row.status)) {
      update.completedAt = new Date(input.eventCreatedSeconds * 1000);
    }

    // TS-307a — an adverse finding against an ALREADY-ACTIVE provider is a
    // trust & safety matter. Read the provider's status before the write so
    // the transaction stays as narrow as possible; the read is a projection
    // of one column because nothing else is needed and the provider row
    // carries profile content this path has no business touching.
    const providerStatus = await this.findProviderStatus(row.providerId);

    // The update and the event append share one transaction (CLAUDE.md §5.3):
    // a rolled-back webhook raises no incident, and a raised incident always
    // corresponds to a persisted finding. Sequential, not concurrent — both
    // go to the same connection.
    const updated = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      const written = (await tx.providerBackgroundCheck.update({
        where: { id: row.id },
        data: update,
      })) as BackgroundCheckRecord;

      if (providerStatus !== null) {
        await this.adverseFinding.emitAdverseFinding(tx as unknown as OutboxRawExecutor, {
          providerId: row.providerId,
          backgroundCheckId: row.id,
          previousStatus: row.status,
          nextStatus,
          providerStatus,
          checkrEventId: input.eventId,
          occurredAt: new Date(input.eventCreatedSeconds * 1000),
        });
      } else {
        // A check whose provider row has vanished. Nothing to raise
        // against, but it is a data-integrity problem, not a normal path.
        this.logger.warn(
          { checkId: row.id, providerId: row.providerId },
          'backgroundCheck.applyWebhookEvent: no provider row for check — adverse-finding screening skipped',
        );
      }

      return written;
    });

    this.logger.log(
      {
        reportId: input.report.id,
        eventId: input.eventId,
        eventType: input.eventType,
        checkId: row.id,
        previousStatus: row.status,
        nextStatus: updated.status,
      },
      'backgroundCheck.applyWebhookEvent ok',
    );
    return ok(updated);
  }

  /**
   * The provider's current status, or `null` when the row is gone.
   * One projected column — see the call site.
   */
  private async findProviderStatus(providerId: string): Promise<ProviderRecordStatus | null> {
    const row = (await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { status: true },
    })) as { readonly status: ProviderRecordStatus } | null;
    return row === null ? null : row.status;
  }
}

/**
 * Map Checkr's free-text status string to the local enum. Unknown
 * Checkr strings fall through to `failed` (intentionally
 * conservative — operators can move a row out of `failed` via admin
 * tooling once TS-127 lands; the alternative of silently treating an
 * unknown status as `processing` would mask Checkr API drift).
 *
 * Checkr's documented `report.status` values as of Phase 1:
 *   pending | processing | clear | consider | suspended | engaged
 *   | dispute | canceled | expired
 *
 * `expired` maps to local `failed` because both mean "did not
 * complete" with no recoverable next step.
 */
function mapCheckrStatusString(raw: string): BackgroundCheckRecordStatus {
  switch (raw) {
    case 'pending':
      return 'pending';
    case 'processing':
      return 'processing';
    case 'clear':
      return 'clear';
    case 'consider':
      return 'consider';
    case 'suspended':
      return 'suspended';
    case 'engaged':
      return 'engaged';
    case 'dispute':
      return 'dispute';
    case 'canceled':
      return 'canceled';
    case 'expired':
    case 'failed':
      return 'failed';
    default:
      return 'failed';
  }
}

function isTerminalStatus(status: BackgroundCheckRecordStatus): boolean {
  return (
    status === 'clear' || status === 'consider' || status === 'canceled' || status === 'failed'
  );
}

function checkrFailureToServiceFailure(failure: CheckrFailure): BackgroundCheckServiceFailure {
  switch (failure.reason) {
    case 'checkr_unavailable':
      return { reason: 'checkr_unavailable', cause: failure.cause };
    case 'invalid_request':
      return { reason: 'checkr_invalid_applicant', message: failure.message };
    case 'unexpected_response':
      return { reason: 'checkr_unavailable', cause: failure };
  }
}

function parseStateList(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((part) => part.trim().toUpperCase())
    .filter((part) => part.length > 0);
}
