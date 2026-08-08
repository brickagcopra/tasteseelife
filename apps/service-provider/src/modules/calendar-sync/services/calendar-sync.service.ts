import { randomBytes } from 'node:crypto';

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX,
  PROVIDER_CALENDAR_SYNC_ERROR_MAX_LENGTH,
  PROVIDER_CALENDAR_SYNCED,
  type ProviderCalendarConnectionRecord,
  type ProviderCalendarConnectionStatus,
} from '@taste-and-see/contracts';
import { OutboxService, type OutboxRawExecutor } from '@taste-and-see/nest-outbox';
import { withSpan } from '@taste-and-see/tracing';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import {
  CalendarSyncMetrics,
  disconnectFailureOutcome,
  syncFailureOutcome,
  type CalendarConnectOutcome,
  type CalendarDisconnectOutcome,
  type CalendarSyncOutcome,
} from './calendar-sync-metrics';
import { CalendarTokenCipherService } from './calendar-token-cipher.service';
import {
  GOOGLE_CALENDAR_PORT,
  GoogleCalendarError,
  type ExternalBusyInterval,
  type GoogleCalendarPort,
  type GoogleOAuthConfig,
} from './google-calendar.port';
import { signOAuthState, verifyOAuthState } from './oauth-state';
import { err, ok, type Result } from './result';

/** Calendar provider literal — Phase-1 Google only. */
const CALENDAR_PROVIDER_GOOGLE = 'google' as const;

/**
 * Fully-resolved calendar-sync configuration. `resolveConfig()` returns
 * this when every required env field + the cipher key are present, or
 * null otherwise (→ `503 calendar_sync_not_configured`).
 */
interface ResolvedCalendarConfig {
  readonly oauth: GoogleOAuthConfig;
  readonly stateSecret: string;
  readonly postConnectRedirectUrl: string;
  readonly syncWindowDays: number;
  readonly stateTtlSeconds: number;
}

interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly deletedAt: Date | null;
}

interface ConnectionRow {
  readonly id: string;
  readonly providerId: string;
  readonly status: ProviderCalendarConnectionStatus;
  readonly connectedAccountEmail: string | null;
  readonly grantedScope: string | null;
  readonly refreshTokenCiphertext: Buffer;
  readonly refreshTokenIv: Buffer;
  readonly refreshTokenAuthTag: Buffer;
  readonly refreshTokenKeyVersion: number;
  readonly lastSyncedAt: Date | null;
  readonly lastSyncError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type CalendarSyncFailure =
  | { readonly reason: 'not_configured' }
  | { readonly reason: 'invalid_request'; readonly message: string }
  | { readonly reason: 'not_found'; readonly providerId: string }
  | { readonly reason: 'forbidden'; readonly providerId: string }
  | { readonly reason: 'not_connected'; readonly providerId: string }
  | { readonly reason: 'exchange_failed'; readonly message: string }
  | { readonly reason: 'sync_auth_rejected'; readonly providerId: string }
  | { readonly reason: 'sync_failed'; readonly message: string }
  | {
      readonly reason: 'outbox_validation_failed';
      readonly eventName: string;
      readonly message: string;
    };

export interface StartConnectionInput {
  readonly providerId: string;
  readonly actorUserId: string;
}

export interface SyncProviderInput {
  readonly providerId: string;
  readonly actorUserId: string;
}

export interface DisconnectInput {
  readonly providerId: string;
  readonly actorUserId: string;
}

export interface CompleteConnectionInput {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
}

export interface SyncOutcome {
  readonly providerId: string;
  readonly externalBusyCount: number;
  readonly lastSyncedAt: Date;
}

export interface DisconnectOutcome {
  readonly providerId: string;
  readonly disconnected: boolean;
  readonly removedExternalBusyCount: number;
}

/**
 * Result of the unauthenticated OAuth callback. The browser is bounced
 * back to the portal on success and on recoverable error; a forged /
 * expired state never follows a redirect (it could point an attacker's
 * state at the victim's portal) → `invalid_state` answers 400; a feature
 * that isn't configured answers 503.
 */
export type CompleteConnectionOutcome =
  | { readonly kind: 'redirect'; readonly url: string }
  | { readonly kind: 'invalid_state' }
  | { readonly kind: 'not_configured' };

class OutboxValidationFailedError extends Error {
  constructor(
    public readonly eventName: string,
    public readonly issues: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>,
  ) {
    super(`outbox.append validation failed for ${eventName}`);
    this.name = 'OutboxValidationFailedError';
  }
}

/**
 * `CalendarSyncService` (TS-206) — owns the Google Calendar free/busy
 * sync surface: OAuth connect, callback, manual re-sync, disconnect, the
 * connection snapshot, and the external busy mirror the availability
 * projection unions.
 *
 * **Feature gate.** `resolveConfig()` collapses the optional env (Google
 * OAuth credentials + cipher key + state secret) into one resolved
 * object, or null. Every entry point returns `not_configured` (→ 503)
 * when null, so the feature ships dark behind the absence of its config
 * (ADR-0003 / CLAUDE.md §11).
 *
 * **Network outside the transaction.** Token exchange + free/busy query
 * are network calls — they run BEFORE the short DB transaction that
 * upserts the connection + replaces the busy mirror + appends the
 * outbox event, so we never hold a transaction open across a network
 * round-trip (CLAUDE.md §7 — HTTP handlers / transactions stay short).
 *
 * **Tenant scoping.** Authenticated entry points run behind
 * `AccessTokenGuard` (the interceptor seeds a scoped frame). The
 * unauthenticated callback wraps its writes in `runWithoutTenantContext`
 * at the controller (the signed `state` is the identity boundary).
 */
@Injectable()
export class CalendarSyncService {
  private readonly logger = new Logger(CalendarSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly cipher: CalendarTokenCipherService,
    @Inject(GOOGLE_CALENDAR_PORT) private readonly google: GoogleCalendarPort,
    @Inject(ENV_TOKEN) private readonly env: Env,
    // Optional default (TS-206-followup-8) — the existing five-arg unit-
    // test call sites keep working; Nest injects the registered provider
    // in prod. No-op meter until `initMetrics` runs (ProviderPricingMetrics
    // precedent).
    private readonly metrics: CalendarSyncMetrics = new CalendarSyncMetrics(),
  ) {}

  /**
   * Resolve the calendar-sync configuration. Returns null (→
   * `not_configured`) when any required field is missing OR the cipher
   * key is unset — the feature is all-or-nothing.
   */
  resolveConfig(): ResolvedCalendarConfig | null {
    const clientId = this.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID;
    const clientSecret = this.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET;
    const redirectUri = this.env.GOOGLE_CALENDAR_OAUTH_REDIRECT_URI;
    const stateSecret = this.env.GOOGLE_CALENDAR_OAUTH_STATE_SECRET;
    const postConnectRedirectUrl = this.env.GOOGLE_CALENDAR_POST_CONNECT_REDIRECT_URL;
    if (
      clientId === undefined ||
      clientSecret === undefined ||
      redirectUri === undefined ||
      stateSecret === undefined ||
      postConnectRedirectUrl === undefined ||
      !this.cipher.isConfigured()
    ) {
      return null;
    }
    return {
      oauth: { clientId, clientSecret, redirectUri },
      stateSecret,
      postConnectRedirectUrl,
      syncWindowDays: this.env.GOOGLE_CALENDAR_SYNC_WINDOW_DAYS,
      stateTtlSeconds: this.env.CALENDAR_OAUTH_STATE_TTL_SECONDS,
    };
  }

  // ─── Connect (initiate) ────────────────────────────────────────────────

  /**
   * Public connect-initiation entry point. Wraps {@link runStartConnection}
   * in a `provider.calendar.connect_start` span (parenting the
   * auto-instrumented Prisma pg child spans) and records the bounded
   * outcome on the span. No counter — the connection only forms at
   * callback time, so `calendar_connect_total` lives on
   * {@link completeConnection}; this read-only OAuth-URL generation gets a
   * span for trace completeness (TS-206-followup-8).
   */
  async startConnection(
    input: StartConnectionInput,
  ): Promise<Result<{ readonly authorizationUrl: string }, CalendarSyncFailure>> {
    return withSpan('provider.calendar.connect_start', async (span) => {
      const result = await this.runStartConnection(input);
      span.setAttribute('provider.calendar.outcome', result.ok ? 'initiated' : result.error.reason);
      return result;
    });
  }

  private async runStartConnection(
    input: StartConnectionInput,
  ): Promise<Result<{ readonly authorizationUrl: string }, CalendarSyncFailure>> {
    if (input.providerId.length === 0 || input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId and actorUserId are required' });
    }
    const config = this.resolveConfig();
    if (config === null) return err({ reason: 'not_configured' });

    const ownership = await this.loadOwnedProvider(input.providerId, input.actorUserId);
    if (!ownership.ok) return ownership;

    const nowSeconds = Math.floor(Date.now() / 1000);
    const state = signOAuthState(config.stateSecret, {
      providerId: input.providerId,
      actorUserId: input.actorUserId,
      nonce: randomBytes(16).toString('base64url'),
      exp: nowSeconds + config.stateTtlSeconds,
    });
    const authorizationUrl = this.google.buildAuthorizationUrl(config.oauth, { state });

    this.logger.log({ providerId: input.providerId }, 'calendar-sync.connect initiated');
    return ok({ authorizationUrl });
  }

  // ─── Callback (complete) ───────────────────────────────────────────────

  /**
   * Public OAuth-callback entry point. Wraps {@link runCompleteConnection}
   * in a `provider.calendar.connect_complete` span and records the bounded
   * {@link CalendarConnectOutcome} on `calendar_connect_total` (plus the
   * mirrored-interval count on `calendar_external_busy_intervals` when a
   * connection was persisted). The internal `runCompleteConnection`
   * carries the metric label + busy count alongside the public
   * {@link CompleteConnectionOutcome} the controller consumes; this
   * wrapper strips them back off. Mirrors the `ProviderPricingService`
   * shape (TS-204-followup-4) (TS-206-followup-8).
   */
  async completeConnection(input: CompleteConnectionInput): Promise<CompleteConnectionOutcome> {
    return withSpan('provider.calendar.connect_complete', async (span) => {
      // Default to `error` so an unexpected throw records a bounded
      // outcome rather than mislabelling the sample.
      let metric: CalendarConnectOutcome = 'error';
      let busyCount: number | null = null;
      try {
        const result = await this.runCompleteConnection(input);
        metric = result.metric;
        busyCount = result.busyCount;
        return result.outcome;
      } finally {
        span.setAttribute('provider.calendar.outcome', metric);
        this.metrics.recordConnect(metric);
        if (busyCount !== null) {
          this.metrics.recordExternalBusyIntervals('connect', busyCount);
        }
      }
    });
  }

  private async runCompleteConnection(input: CompleteConnectionInput): Promise<{
    readonly outcome: CompleteConnectionOutcome;
    readonly metric: CalendarConnectOutcome;
    readonly busyCount: number | null;
  }> {
    const config = this.resolveConfig();
    if (config === null) {
      return { outcome: { kind: 'not_configured' }, metric: 'not_configured', busyCount: null };
    }

    const verified = verifyOAuthState(
      config.stateSecret,
      input.state,
      Math.floor(Date.now() / 1000),
    );
    if (!verified.ok) {
      this.logger.warn({ reason: verified.reason }, 'calendar-sync.callback rejected state');
      return { outcome: { kind: 'invalid_state' }, metric: 'invalid_state', busyCount: null };
    }
    const { providerId, actorUserId } = verified.payload;

    // Google sent `error=access_denied` (the provider declined consent)
    // or no `code`. Bounce back to the portal with an error banner.
    if (input.error !== undefined || input.code === undefined) {
      return {
        outcome: { kind: 'redirect', url: this.redirectUrl(config, 'error', 'consent_declined') },
        metric: 'consent_declined',
        busyCount: null,
      };
    }

    // Confirm the state still maps to an owned, live provider row.
    const ownership = await this.loadOwnedProvider(providerId, actorUserId);
    if (!ownership.ok) {
      return {
        outcome: { kind: 'redirect', url: this.redirectUrl(config, 'error', 'provider_mismatch') },
        metric: 'provider_mismatch',
        busyCount: null,
      };
    }

    let tokens;
    try {
      tokens = await this.google.exchangeCode(config.oauth, { code: input.code });
    } catch (e) {
      const message = e instanceof GoogleCalendarError ? e.kind : 'exchange_error';
      this.logger.error({ providerId, kind: message }, 'calendar-sync.callback exchange failed');
      return {
        outcome: { kind: 'redirect', url: this.redirectUrl(config, 'error', 'exchange_failed') },
        metric: 'exchange_failed',
        busyCount: null,
      };
    }

    // Pull the initial free/busy window OUTSIDE the write transaction.
    let intervals: readonly ExternalBusyInterval[] = [];
    let syncStatus: ProviderCalendarConnectionStatus = 'connected';
    let syncError: string | null = null;
    try {
      intervals = await this.queryWindow(config, tokens.refreshToken);
    } catch (e) {
      // The token is fresh, so a failure here is most likely transient.
      // Persist the connection anyway (the token is valid) with an error
      // status so the portal surfaces "first sync failed, retry".
      syncStatus = 'error';
      syncError = truncateError(e instanceof Error ? e.message : 'initial sync failed');
    }

    const encrypted = this.cipher.encrypt(tokens.refreshToken);

    try {
      await this.writeConnectionAndBusy({
        providerId,
        actorUserId,
        status: syncStatus,
        connectedAccountEmail: tokens.accountEmail,
        grantedScope: tokens.scope,
        encrypted,
        intervals,
        lastSyncError: syncError,
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        this.logger.error(
          { providerId, eventName: e.eventName, issues: e.issues },
          'calendar-sync.callback outbox validation failed; tx rolled back',
        );
        return {
          outcome: { kind: 'redirect', url: this.redirectUrl(config, 'error', 'persist_failed') },
          metric: 'persist_failed',
          busyCount: null,
        };
      }
      throw e;
    }

    this.logger.log(
      { providerId, status: syncStatus, externalBusyCount: intervals.length },
      'calendar-sync.callback connected',
    );
    // The connection row persisted (the token is valid) regardless of
    // whether the initial free/busy pull succeeded — so the mirrored
    // interval count (0 when the first pull failed) is a meaningful
    // `connect`-phase observation either way.
    return {
      outcome: {
        kind: 'redirect',
        url: this.redirectUrl(config, syncStatus === 'connected' ? 'connected' : 'error', null),
      },
      metric: syncStatus === 'connected' ? 'connected' : 'connected_sync_error',
      busyCount: intervals.length,
    };
  }

  // ─── Manual sync ───────────────────────────────────────────────────────

  /**
   * Public manual-resync entry point. Wraps {@link runSyncProvider} in a
   * `provider.calendar.sync` span and records the bounded
   * {@link CalendarSyncOutcome} on `calendar_sync_total` (plus the
   * mirrored-interval count on `calendar_external_busy_intervals` on
   * success) (TS-206-followup-8).
   */
  async syncProvider(input: SyncProviderInput): Promise<Result<SyncOutcome, CalendarSyncFailure>> {
    return withSpan('provider.calendar.sync', async (span) => {
      let outcome: CalendarSyncOutcome = 'error';
      let busyCount: number | null = null;
      try {
        const result = await this.runSyncProvider(input);
        if (result.ok) {
          outcome = 'ok';
          busyCount = result.value.externalBusyCount;
        } else {
          outcome = syncFailureOutcome(result.error);
        }
        return result;
      } finally {
        span.setAttribute('provider.calendar.outcome', outcome);
        this.metrics.recordSync(outcome);
        if (busyCount !== null) {
          this.metrics.recordExternalBusyIntervals('sync', busyCount);
        }
      }
    });
  }

  private async runSyncProvider(
    input: SyncProviderInput,
  ): Promise<Result<SyncOutcome, CalendarSyncFailure>> {
    if (input.providerId.length === 0 || input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId and actorUserId are required' });
    }
    const config = this.resolveConfig();
    if (config === null) return err({ reason: 'not_configured' });

    const ownership = await this.loadOwnedProvider(input.providerId, input.actorUserId);
    if (!ownership.ok) return ownership;

    const connection = (await this.prisma.providerCalendarConnection.findUnique({
      where: { providerId: input.providerId },
      select: CONNECTION_SELECT,
    })) as ConnectionRow | null;
    if (connection === null) {
      return err({ reason: 'not_connected', providerId: input.providerId });
    }

    const refreshToken = this.cipher.decrypt({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      authTag: connection.refreshTokenAuthTag,
      keyVersion: connection.refreshTokenKeyVersion,
    });

    let intervals: readonly ExternalBusyInterval[];
    try {
      intervals = await this.queryWindow(config, refreshToken);
    } catch (e) {
      const authRejected = e instanceof GoogleCalendarError && e.kind === 'auth_rejected';
      // Persist the failure state so the portal reflects "reconnect
      // needed" / "sync failing". Emit the re-project trigger with the
      // CURRENT busy set unchanged is overkill — we set status=error and
      // leave the mirror intact (a transient failure shouldn't wipe a
      // still-valid mirror).
      await this.markConnectionError(
        input.providerId,
        truncateError(e instanceof Error ? e.message : 'sync failed'),
      );
      if (authRejected) {
        return err({ reason: 'sync_auth_rejected', providerId: input.providerId });
      }
      return err({
        reason: 'sync_failed',
        message: e instanceof Error ? e.message : 'sync failed',
      });
    }

    let outcome: SyncOutcome;
    try {
      outcome = await this.replaceBusyAndEmit({
        providerId: input.providerId,
        actorUserId: input.actorUserId,
        intervals,
      });
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }

    this.logger.log(
      { providerId: input.providerId, externalBusyCount: outcome.externalBusyCount },
      'calendar-sync.sync ok',
    );
    return ok(outcome);
  }

  // ─── Disconnect ────────────────────────────────────────────────────────

  /**
   * Public disconnect entry point. Wraps {@link runDisconnect} in a
   * `provider.calendar.disconnect` span and records the bounded
   * {@link CalendarDisconnectOutcome} on `calendar_disconnect_total` —
   * `disconnected` for a real teardown, `already_disconnected` for the
   * idempotent no-op (TS-206-followup-8).
   */
  async disconnect(
    input: DisconnectInput,
  ): Promise<Result<DisconnectOutcome, CalendarSyncFailure>> {
    return withSpan('provider.calendar.disconnect', async (span) => {
      let outcome: CalendarDisconnectOutcome = 'error';
      try {
        const result = await this.runDisconnect(input);
        if (result.ok) {
          outcome = result.value.disconnected ? 'disconnected' : 'already_disconnected';
        } else {
          outcome = disconnectFailureOutcome(result.error);
        }
        return result;
      } finally {
        span.setAttribute('provider.calendar.outcome', outcome);
        this.metrics.recordDisconnect(outcome);
      }
    });
  }

  private async runDisconnect(
    input: DisconnectInput,
  ): Promise<Result<DisconnectOutcome, CalendarSyncFailure>> {
    if (input.providerId.length === 0 || input.actorUserId.length === 0) {
      return err({ reason: 'invalid_request', message: 'providerId and actorUserId are required' });
    }
    const config = this.resolveConfig();
    if (config === null) return err({ reason: 'not_configured' });

    const ownership = await this.loadOwnedProvider(input.providerId, input.actorUserId);
    if (!ownership.ok) return ownership;

    const connection = (await this.prisma.providerCalendarConnection.findUnique({
      where: { providerId: input.providerId },
      select: CONNECTION_SELECT,
    })) as ConnectionRow | null;
    if (connection === null) {
      // Idempotent — already disconnected.
      return ok({ providerId: input.providerId, disconnected: false, removedExternalBusyCount: 0 });
    }

    // Best-effort revoke at Google BEFORE the local delete (decrypt while
    // the row still exists). A revoke failure does not block the local
    // cleanup — the adapter swallows it.
    const refreshToken = this.cipher.decrypt({
      ciphertext: connection.refreshTokenCiphertext,
      iv: connection.refreshTokenIv,
      authTag: connection.refreshTokenAuthTag,
      keyVersion: connection.refreshTokenKeyVersion,
    });
    await this.google.revokeRefreshToken(config.oauth, { refreshToken });

    const now = new Date();
    let removedExternalBusyCount = 0;
    try {
      removedExternalBusyCount = await this.prisma.$transaction(
        async (tx: PrismaTransactionClient): Promise<number> => {
          const removed = await tx.providerCalendarExternalBusy.deleteMany({
            where: { providerId: input.providerId },
          });
          await tx.providerCalendarConnection.delete({
            where: { providerId: input.providerId },
          });
          await this.appendSyncedEvent(tx, {
            providerId: input.providerId,
            externalBusyCount: 0,
            actorUserId: input.actorUserId,
            now,
          });
          return removed.count;
        },
      );
    } catch (e) {
      if (e instanceof OutboxValidationFailedError) {
        return err({
          reason: 'outbox_validation_failed',
          eventName: e.eventName,
          message: `event ${e.eventName} payload failed validation`,
        });
      }
      throw e;
    }

    this.logger.log(
      { providerId: input.providerId, removedExternalBusyCount },
      'calendar-sync.disconnect ok',
    );
    return ok({ providerId: input.providerId, disconnected: true, removedExternalBusyCount });
  }

  // ─── Reads ─────────────────────────────────────────────────────────────

  /**
   * Snapshot for the authenticated provider. Returns null when the user
   * has no provider row OR no calendar connection.
   */
  async getConnectionByUserId(userId: string): Promise<ProviderCalendarConnectionRecord | null> {
    if (userId.length === 0) return null;
    const provider = (await this.prisma.provider.findUnique({
      where: { userId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;
    if (provider === null || provider.deletedAt !== null) return null;

    const connection = (await this.prisma.providerCalendarConnection.findUnique({
      where: { providerId: provider.id },
      select: CONNECTION_SELECT,
    })) as ConnectionRow | null;
    if (connection === null) return null;

    const externalBusyCount = await this.prisma.providerCalendarExternalBusy.count({
      where: { providerId: provider.id },
    });
    return toConnectionRecord(connection, externalBusyCount);
  }

  /**
   * The external busy intervals the availability projection unions
   * (TS-203 `resolveNextSevenDays`). Ordered by start. Read-only;
   * returns an empty array when no connection / no mirror.
   */
  async getExternalBusyIntervals(providerId: string): Promise<readonly ExternalBusyInterval[]> {
    if (providerId.length === 0) return [];
    const rows = (await this.prisma.providerCalendarExternalBusy.findMany({
      where: { providerId },
      select: { startsAt: true, endsAt: true },
      orderBy: { startsAt: 'asc' },
    })) as ReadonlyArray<{ readonly startsAt: Date; readonly endsAt: Date }>;
    return rows.map((row) => ({ startAt: row.startsAt, endAt: row.endsAt }));
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private async loadOwnedProvider(
    providerId: string,
    actorUserId: string,
  ): Promise<Result<ProviderRow, CalendarSyncFailure>> {
    const provider = (await this.prisma.provider.findUnique({
      where: { id: providerId },
      select: { id: true, userId: true, deletedAt: true },
    })) as ProviderRow | null;
    if (provider === null || provider.deletedAt !== null) {
      return err({ reason: 'not_found', providerId });
    }
    if (provider.userId !== actorUserId) {
      return err({ reason: 'forbidden', providerId });
    }
    return ok(provider);
  }

  private async queryWindow(
    config: ResolvedCalendarConfig,
    refreshToken: string,
  ): Promise<readonly ExternalBusyInterval[]> {
    const timeMin = new Date();
    const timeMax = new Date(timeMin.getTime() + config.syncWindowDays * 24 * 60 * 60 * 1000);
    const intervals = await this.google.queryBusyIntervals(config.oauth, {
      refreshToken,
      timeMin,
      timeMax,
    });
    // Bound the mirror at the contract cap — a pathological calendar
    // cannot blow up the table / the union work.
    return intervals.slice(0, PROVIDER_CALENDAR_EXTERNAL_BUSY_MAX);
  }

  /**
   * Upsert the connection row + replace the busy mirror + emit the
   * re-project event, all in one short transaction (no network inside).
   */
  private async writeConnectionAndBusy(input: {
    readonly providerId: string;
    readonly actorUserId: string;
    readonly status: ProviderCalendarConnectionStatus;
    readonly connectedAccountEmail: string | null;
    readonly grantedScope: string | null;
    readonly encrypted: {
      readonly ciphertext: Buffer;
      readonly iv: Buffer;
      readonly authTag: Buffer;
      readonly keyVersion: number;
    };
    readonly intervals: readonly ExternalBusyInterval[];
    readonly lastSyncError: string | null;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx: PrismaTransactionClient): Promise<void> => {
      await tx.providerCalendarConnection.upsert({
        where: { providerId: input.providerId },
        create: {
          providerId: input.providerId,
          calendarProvider: CALENDAR_PROVIDER_GOOGLE,
          status: input.status,
          connectedAccountEmail: input.connectedAccountEmail,
          grantedScope: input.grantedScope,
          refreshTokenCiphertext: input.encrypted.ciphertext,
          refreshTokenIv: input.encrypted.iv,
          refreshTokenAuthTag: input.encrypted.authTag,
          refreshTokenKeyVersion: input.encrypted.keyVersion,
          lastSyncedAt: input.status === 'connected' ? now : null,
          lastSyncError: input.lastSyncError,
        },
        update: {
          status: input.status,
          connectedAccountEmail: input.connectedAccountEmail,
          grantedScope: input.grantedScope,
          refreshTokenCiphertext: input.encrypted.ciphertext,
          refreshTokenIv: input.encrypted.iv,
          refreshTokenAuthTag: input.encrypted.authTag,
          refreshTokenKeyVersion: input.encrypted.keyVersion,
          lastSyncedAt: input.status === 'connected' ? now : null,
          lastSyncError: input.lastSyncError,
        },
      });
      await this.rewriteBusyRows(tx, input.providerId, input.intervals, now);
      await this.appendSyncedEvent(tx, {
        providerId: input.providerId,
        externalBusyCount: input.intervals.length,
        actorUserId: input.actorUserId,
        now,
      });
    });
  }

  /**
   * Replace the busy mirror + bump the connection's sync state + emit
   * the event, in one transaction. Used by the manual / scheduled sync
   * path (the connection row already exists).
   */
  private async replaceBusyAndEmit(input: {
    readonly providerId: string;
    readonly actorUserId: string;
    readonly intervals: readonly ExternalBusyInterval[];
  }): Promise<SyncOutcome> {
    const now = new Date();
    await this.prisma.$transaction(async (tx: PrismaTransactionClient): Promise<void> => {
      await tx.providerCalendarConnection.update({
        where: { providerId: input.providerId },
        data: { status: 'connected', lastSyncedAt: now, lastSyncError: null },
      });
      await this.rewriteBusyRows(tx, input.providerId, input.intervals, now);
      await this.appendSyncedEvent(tx, {
        providerId: input.providerId,
        externalBusyCount: input.intervals.length,
        actorUserId: input.actorUserId,
        now,
      });
    });
    return {
      providerId: input.providerId,
      externalBusyCount: input.intervals.length,
      lastSyncedAt: now,
    };
  }

  private async rewriteBusyRows(
    tx: PrismaTransactionClient,
    providerId: string,
    intervals: readonly ExternalBusyInterval[],
    syncedAt: Date,
  ): Promise<void> {
    await tx.providerCalendarExternalBusy.deleteMany({ where: { providerId } });
    if (intervals.length > 0) {
      await tx.providerCalendarExternalBusy.createMany({
        data: intervals.map((interval) => ({
          providerId,
          source: CALENDAR_PROVIDER_GOOGLE,
          startsAt: interval.startAt,
          endsAt: interval.endAt,
          syncedAt,
        })),
      });
    }
  }

  /**
   * Mark the connection `error` with a message — used when a sync fails
   * but we want to preserve the existing mirror + the stored token.
   */
  private async markConnectionError(providerId: string, message: string): Promise<void> {
    await this.prisma.providerCalendarConnection.update({
      where: { providerId },
      data: { status: 'error', lastSyncError: message },
    });
  }

  private async appendSyncedEvent(
    tx: PrismaTransactionClient,
    input: {
      readonly providerId: string;
      readonly externalBusyCount: number;
      readonly actorUserId: string | null;
      readonly now: Date;
    },
  ): Promise<void> {
    const eventId = `${input.providerId}.calendar_synced.${input.now.getTime()}`;
    const appended = await this.outbox.append(tx as unknown as OutboxRawExecutor, {
      eventName: PROVIDER_CALENDAR_SYNCED,
      eventId,
      occurredAt: input.now,
      payload: {
        eventId,
        occurredAt: input.now.toISOString(),
        providerId: input.providerId,
        calendarProvider: CALENDAR_PROVIDER_GOOGLE,
        externalBusyCount: input.externalBusyCount,
        actorUserId: input.actorUserId,
      },
    });
    if (appended.kind !== 'appended') {
      throw new OutboxValidationFailedError(appended.eventName, appended.issues);
    }
  }

  private redirectUrl(
    config: ResolvedCalendarConfig,
    outcome: 'connected' | 'error',
    reason: string | null,
  ): string {
    const url = new URL(config.postConnectRedirectUrl);
    url.searchParams.set('calendar', outcome);
    if (reason !== null) url.searchParams.set('reason', reason);
    return url.toString();
  }
}

const CONNECTION_SELECT = {
  id: true,
  providerId: true,
  status: true,
  connectedAccountEmail: true,
  grantedScope: true,
  refreshTokenCiphertext: true,
  refreshTokenIv: true,
  refreshTokenAuthTag: true,
  refreshTokenKeyVersion: true,
  lastSyncedAt: true,
  lastSyncError: true,
  createdAt: true,
  updatedAt: true,
} as const;

function truncateError(message: string): string {
  return message.length > PROVIDER_CALENDAR_SYNC_ERROR_MAX_LENGTH
    ? message.slice(0, PROVIDER_CALENDAR_SYNC_ERROR_MAX_LENGTH)
    : message;
}

/**
 * Map a connection row + the mirror count to the public DTO. Carries NO
 * token material — the four `refresh_token_*` columns never leave the
 * service.
 */
export function toConnectionRecord(
  row: ConnectionRow,
  externalBusyCount: number,
): ProviderCalendarConnectionRecord {
  return {
    providerId: row.providerId,
    calendarProvider: CALENDAR_PROVIDER_GOOGLE,
    status: row.status,
    connectedAccountEmail: row.connectedAccountEmail,
    externalBusyCount,
    lastSyncedAt: row.lastSyncedAt === null ? null : row.lastSyncedAt.toISOString(),
    lastSyncError: row.lastSyncError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
