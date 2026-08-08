import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DispatchNotificationRequest,
  NotificationCategory,
  NotificationChannelKind,
  NotificationDispatchStatus,
  NotificationSuppressionReason,
  RenderTemplateResponse,
} from '@taste-and-see/contracts';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService } from '../../../prisma/prisma.service';
import { TemplatesService } from '../../templates/services/templates.service';

import { EmailDispatcher } from '../channels/email-dispatcher.service';
import { PushDispatcher } from '../channels/push-dispatcher.service';
import { SmsDispatcher } from '../channels/sms-dispatcher.service';
import type { ChannelDispatcher, ChannelDispatchOutcome } from '../channels/channel-dispatcher';

import { PreferenceGateService } from './preference-gate.service';

/**
 * Dispatch orchestrator (TS-073).
 *
 * Single entry point for every notification send. Owns the four-step
 * lifecycle:
 *
 *   1. **Idempotency lookup.** If a dispatch row with the same
 *      `idempotency_key` already exists, return it as `replayed: true`
 *      without re-running any work. This defends against upstream
 *      retries (HTTP timeouts, BullMQ replays, ...).
 *
 *   2. **Preference + quiet-hours gate.** Consults
 *      `PreferenceGateService.decide`. On suppress, persists a row with
 *      status = `suppressed_by_*` + the typed reason and returns
 *      immediately.
 *
 *   3. **Template render.** Calls `TemplatesService.render` in-process
 *      (no HTTP hop). Render failures (missing template, variable
 *      validation, Handlebars error) persist a `failed` row + return.
 *
 *   4. **Channel dispatch.** Picks the adapter by channel kind and
 *      delegates. Persists a `sent` row (with provider message id) or
 *      `failed` row (with error message). The four channels each have
 *      a Phase-1 stub adapter; live SDK wiring lands as
 *      TS-073-followup-1/2/3 per channel.
 *
 * **In-app channel.** Not supported in TS-073 — the Socket.IO + Redis
 * adapter ships with TS-071. The orchestrator currently returns a
 * `failed` row with a clear error for `channel = 'in_app'`.
 *
 * **Persistence layer.** All writes go through a single `prisma.create`
 * after the outcome is determined; the orchestrator never persists a
 * partial state. The DB CHECK constraint on the dispatch row enforces
 * the per-status invariants as a backstop.
 */
@Injectable()
export class DispatchOrchestratorService {
  private readonly logger = new Logger(DispatchOrchestratorService.name);
  private readonly dispatchers: ReadonlyMap<NotificationChannelKind, ChannelDispatcher>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly gate: PreferenceGateService,
    emailDispatcher: EmailDispatcher,
    smsDispatcher: SmsDispatcher,
    pushDispatcher: PushDispatcher,
    @Inject(ENV_TOKEN) private readonly env: Env,
  ) {
    this.dispatchers = new Map<NotificationChannelKind, ChannelDispatcher>([
      ['email', emailDispatcher],
      ['sms', smsDispatcher],
      ['push', pushDispatcher],
    ]);
  }

  async dispatch(
    request: DispatchNotificationRequest,
    now: Date = new Date(),
  ): Promise<DispatchResult> {
    // Step 1 — idempotency lookup.
    const existing = await this.findExistingByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      return { dispatch: existing, replayed: true };
    }

    // Step 2 — preference + quiet-hours gate.
    const decision = await this.gate.decide(
      {
        recipientUserId: request.recipientUserId,
        channel: request.channel,
        category: request.category,
        bypassQuietHours: request.bypassQuietHours,
      },
      now,
    );
    if (!decision.allow) {
      const suppressed = await this.persistSuppressed(request, decision.suppressionReason, now);
      return { dispatch: suppressed, replayed: false };
    }

    // Step 3 — template render.
    const renderResult = await this.templates.render({
      templateCode: request.templateCode,
      locale: request.locale,
      variables: request.variables,
    });
    if (renderResult.outcome === 'failed') {
      const failed = await this.persistFailed(
        request,
        null,
        null,
        renderFailureToError(renderResult.failure),
        now,
      );
      return { dispatch: failed, replayed: false };
    }

    // Step 4 — channel dispatch.
    const channelKind = request.channel;
    if (channelKind === 'in_app') {
      // TS-071 ships the Socket.IO real-time fan-out; until then the
      // orchestrator records a failure so the call doesn't silently
      // disappear.
      const failed = await this.persistFailed(
        request,
        renderResult.rendered.templateCode,
        renderResult.rendered.version,
        'in_app channel not yet implemented (TS-071)',
        now,
      );
      return { dispatch: failed, replayed: false };
    }

    const dispatcher = this.dispatchers.get(channelKind);
    if (!dispatcher) {
      const failed = await this.persistFailed(
        request,
        renderResult.rendered.templateCode,
        renderResult.rendered.version,
        `no adapter registered for channel ${channelKind}`,
        now,
      );
      return { dispatch: failed, replayed: false };
    }

    const channelOutcome = await dispatcher.send({
      dispatchId: this.preallocateDispatchId(request),
      recipientAddress: request.recipientAddress,
      rendered: renderResult.rendered,
      fromAddress: this.env.NOTIFICATION_EMAIL_FROM_ADDRESS,
      fromName: this.env.NOTIFICATION_EMAIL_FROM_NAME,
    });

    const persisted = await this.persistChannelOutcome(
      request,
      renderResult.rendered,
      channelOutcome,
      now,
    );
    return { dispatch: persisted, replayed: false };
  }

  // ─── Read paths ──────────────────────────────────────────────────────

  async findById(id: string): Promise<DispatchRow | null> {
    const row = await this.prisma.notificationDispatch.findUnique({ where: { id } });
    return row ? this.toDispatchRow(row) : null;
  }

  async list(query: ListDispatchesInput): Promise<ListDispatchesResult> {
    const limit = query.limit;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.notificationDispatch.findMany({
      where: {
        ...(query.recipientUserId !== undefined && { recipientUserId: query.recipientUserId }),
        ...(query.channel !== undefined && { channel: query.channel }),
        ...(query.category !== undefined && { category: query.category }),
        ...(query.status !== undefined && { status: query.status }),
        ...(decoded !== null && {
          OR: [
            { occurredAt: { lt: decoded.occurredAt } },
            { occurredAt: { equals: decoded.occurredAt }, id: { lt: decoded.id } },
          ],
        }),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });

    if (rows.length <= limit) {
      return { rows: rows.map(this.toDispatchRow), nextCursor: null };
    }
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    if (!last) {
      return { rows: [], nextCursor: null };
    }
    return {
      rows: slice.map(this.toDispatchRow),
      nextCursor: encodeCursor(last.occurredAt, last.id),
    };
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private async findExistingByIdempotencyKey(key: string): Promise<DispatchRow | null> {
    const row = await this.prisma.notificationDispatch.findUnique({
      where: { idempotencyKey: key },
    });
    return row ? this.toDispatchRow(row) : null;
  }

  private async persistSuppressed(
    request: DispatchNotificationRequest,
    reason: NotificationSuppressionReason,
    now: Date,
  ): Promise<DispatchRow> {
    const status = suppressionReasonToStatus(reason);
    const row = await this.prisma.notificationDispatch.create({
      data: {
        recipientUserId: request.recipientUserId,
        channel: request.channel,
        category: request.category,
        templateCode: request.templateCode,
        locale: localeToDb(request.locale),
        templateId: null,
        templateVersionId: null,
        recipientAddress: request.recipientAddress,
        status,
        suppressionReason: reason,
        providerMessageId: null,
        errorMessage: null,
        idempotencyKey: request.idempotencyKey,
        sourceEventId: request.sourceEventId ?? null,
        bypassQuietHours: request.bypassQuietHours,
        occurredAt: now,
        sentAt: null,
      },
    });
    this.logger.log(
      `dispatch suppressed channel=${row.channel} category=${row.category} reason=${reason} dispatchId=${row.id}`,
    );
    return this.toDispatchRow(row);
  }

  private async persistFailed(
    request: DispatchNotificationRequest,
    templateCode: string | null,
    templateVersion: number | null,
    errorMessage: string,
    now: Date,
  ): Promise<DispatchRow> {
    void templateCode;
    void templateVersion;
    const row = await this.prisma.notificationDispatch.create({
      data: {
        recipientUserId: request.recipientUserId,
        channel: request.channel,
        category: request.category,
        templateCode: request.templateCode,
        locale: localeToDb(request.locale),
        templateId: null,
        templateVersionId: null,
        recipientAddress: request.recipientAddress,
        status: 'failed',
        suppressionReason: null,
        providerMessageId: null,
        errorMessage: truncateError(errorMessage),
        idempotencyKey: request.idempotencyKey,
        sourceEventId: request.sourceEventId ?? null,
        bypassQuietHours: request.bypassQuietHours,
        occurredAt: now,
        sentAt: null,
      },
    });
    this.logger.warn(
      `dispatch failed channel=${row.channel} dispatchId=${row.id} error=${row.errorMessage}`,
    );
    return this.toDispatchRow(row);
  }

  private async persistChannelOutcome(
    request: DispatchNotificationRequest,
    rendered: RenderTemplateResponse,
    outcome: ChannelDispatchOutcome,
    now: Date,
  ): Promise<DispatchRow> {
    if (outcome.status === 'failed') {
      return this.persistFailed(
        request,
        rendered.templateCode,
        rendered.version,
        outcome.errorMessage,
        now,
      );
    }

    const sentAt = new Date(now.getTime() + 1); // Strictly after `occurredAt`.
    const row = await this.prisma.notificationDispatch.create({
      data: {
        recipientUserId: request.recipientUserId,
        channel: request.channel,
        category: request.category,
        templateCode: rendered.templateCode,
        locale: localeToDb(request.locale),
        templateId: null,
        templateVersionId: null,
        recipientAddress: request.recipientAddress,
        status: 'sent',
        suppressionReason: null,
        providerMessageId: outcome.providerMessageId,
        errorMessage: null,
        idempotencyKey: request.idempotencyKey,
        sourceEventId: request.sourceEventId ?? null,
        bypassQuietHours: request.bypassQuietHours,
        occurredAt: now,
        sentAt,
      },
    });
    this.logger.log(
      `dispatch sent channel=${row.channel} dispatchId=${row.id} providerMessageId=${row.providerMessageId} live=${outcome.liveMode}`,
    );
    return this.toDispatchRow(row);
  }

  private preallocateDispatchId(request: DispatchNotificationRequest): string {
    // The adapter stub-mode uses the dispatch id as the provider id.
    // We can't know the real Prisma-allocated id until after the
    // `create()` call lands. Use a hash of `idempotencyKey` so the
    // stub provider id is stable across retries — keeps debugging
    // straightforward.
    return `pending-${request.idempotencyKey.slice(0, 24)}`;
  }

  private readonly toDispatchRow = (row: PersistedDispatchRow): DispatchRow => ({
    id: row.id,
    recipientUserId: row.recipientUserId,
    channel: row.channel,
    category: row.category,
    templateCode: row.templateCode,
    locale: dbLocaleToContract(row.locale),
    templateVersionId: row.templateVersionId,
    recipientAddress: row.recipientAddress,
    status: row.status,
    suppressionReason: row.suppressionReason,
    providerMessageId: row.providerMessageId,
    errorMessage: row.errorMessage,
    idempotencyKey: row.idempotencyKey,
    sourceEventId: row.sourceEventId,
    occurredAt: row.occurredAt,
    sentAt: row.sentAt,
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────

function suppressionReasonToStatus(
  reason: NotificationSuppressionReason,
): NotificationDispatchStatus {
  switch (reason) {
    case 'preference_opted_out':
    case 'recipient_address_missing':
      return 'suppressed_by_preference';
    case 'quiet_hours':
      return 'suppressed_by_quiet_hours';
    case 'globally_unsubscribed':
      return 'suppressed_by_unsubscribed';
  }
}

function renderFailureToError(failure: { kind: string; [k: string]: unknown }): string {
  switch (failure.kind) {
    case 'template_or_active_version_not_found':
      return 'template_or_active_version_not_found';
    case 'variable_validation_failed': {
      const rawIssues = failure['issues'];
      if (Array.isArray(rawIssues)) {
        const messages: string[] = [];
        for (const issue of rawIssues) {
          if (
            issue !== null &&
            typeof issue === 'object' &&
            typeof (issue as { message?: unknown }).message === 'string'
          ) {
            messages.push((issue as { message: string }).message);
          }
        }
        return `variable_validation_failed: ${messages.join('; ').slice(0, 1500)}`;
      }
      return 'variable_validation_failed';
    }
    case 'handlebars_render_failed': {
      const message = typeof failure['message'] === 'string' ? failure['message'] : '';
      return `handlebars_render_failed: ${message}`.slice(0, 1500);
    }
    default:
      return `template_render_failed: ${failure.kind}`;
  }
}

function truncateError(message: string): string {
  return message.length > 1900 ? `${message.slice(0, 1900)}…` : message;
}

type DbLocale = 'en_US' | 'es_US' | 'zh_CN';

function localeToDb(value: 'en-US' | 'es-US' | 'zh-CN'): DbLocale {
  switch (value) {
    case 'en-US':
      return 'en_US';
    case 'es-US':
      return 'es_US';
    case 'zh-CN':
      return 'zh_CN';
  }
}

function dbLocaleToContract(value: DbLocale): 'en-US' | 'es-US' | 'zh-CN' {
  switch (value) {
    case 'en_US':
      return 'en-US';
    case 'es_US':
      return 'es-US';
    case 'zh_CN':
      return 'zh-CN';
  }
}

function encodeCursor(occurredAt: Date, id: string): string {
  const payload = JSON.stringify({ occurredAt: occurredAt.toISOString(), id });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (parsed === null || typeof parsed !== 'object') return null;
    const occurredAtRaw = (parsed as Record<string, unknown>)['occurredAt'];
    const idRaw = (parsed as Record<string, unknown>)['id'];
    if (typeof occurredAtRaw !== 'string' || typeof idRaw !== 'string') return null;
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id: idRaw };
  } catch {
    return null;
  }
}

// ─── Public domain types ────────────────────────────────────────────────

export interface DispatchRow {
  readonly id: string;
  readonly recipientUserId: string;
  readonly channel: NotificationChannelKind;
  readonly category: NotificationCategory;
  readonly templateCode: string;
  readonly locale: 'en-US' | 'es-US' | 'zh-CN';
  readonly templateVersionId: string | null;
  readonly recipientAddress: string;
  readonly status: NotificationDispatchStatus;
  readonly suppressionReason: NotificationSuppressionReason | null;
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
  readonly idempotencyKey: string;
  readonly sourceEventId: string | null;
  readonly occurredAt: Date;
  readonly sentAt: Date | null;
}

export interface DispatchResult {
  readonly dispatch: DispatchRow;
  readonly replayed: boolean;
}

export interface ListDispatchesInput {
  readonly recipientUserId?: string;
  readonly channel?: NotificationChannelKind;
  readonly category?: NotificationCategory;
  readonly status?: NotificationDispatchStatus;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ListDispatchesResult {
  readonly rows: DispatchRow[];
  readonly nextCursor: string | null;
}

// ─── Persisted-row shape (mirrors Prisma return) ────────────────────────

interface PersistedDispatchRow {
  id: string;
  recipientUserId: string;
  channel: NotificationChannelKind;
  category: NotificationCategory;
  templateCode: string;
  locale: DbLocale;
  templateId: string | null;
  templateVersionId: string | null;
  recipientAddress: string;
  status: NotificationDispatchStatus;
  suppressionReason: NotificationSuppressionReason | null;
  providerMessageId: string | null;
  errorMessage: string | null;
  idempotencyKey: string;
  sourceEventId: string | null;
  bypassQuietHours: boolean;
  occurredAt: Date;
  sentAt: Date | null;
}
