import type { OutboxService } from '@taste-and-see/nest-outbox';
import { PROVIDER_CALENDAR_SYNCED } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../config/env';
import type { PrismaService } from '../../../prisma/prisma.service';

import {
  CalendarSyncMetrics,
  type CalendarConnectOutcome,
  type CalendarDisconnectOutcome,
  type CalendarSyncOutcome,
} from './calendar-sync-metrics';
import { CalendarSyncService } from './calendar-sync.service';
import { CalendarTokenCipherService } from './calendar-token-cipher.service';
import {
  GoogleCalendarError,
  type ExternalBusyInterval,
  type GoogleCalendarPort,
  type GoogleCalendarTokens,
} from './google-calendar.port';
import { signOAuthState } from './oauth-state';

// ─── Env ─────────────────────────────────────────────────────────────────

const STATE_SECRET = 'state-secret-state-secret-state!';

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    GOOGLE_CALENDAR_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: 'client-secret',
    GOOGLE_CALENDAR_OAUTH_REDIRECT_URI:
      'https://api.example.com/api/v1/providers/calendar/google/callback',
    GOOGLE_CALENDAR_OAUTH_STATE_SECRET: STATE_SECRET,
    GOOGLE_CALENDAR_POST_CONNECT_REDIRECT_URL: 'https://provider.example.com/dashboard/calendar',
    CALENDAR_TOKEN_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
    CALENDAR_TOKEN_ENC_KEY_VERSION: 1,
    GOOGLE_CALENDAR_SYNC_WINDOW_DAYS: 14,
    CALENDAR_OAUTH_STATE_TTL_SECONDS: 600,
    ...overrides,
  } as Env;
}

// ─── Fake Outbox ───────────────────────────────────────────────────────────

interface FakeOutbox {
  readonly calls: Array<{ eventName: string; payload: unknown }>;
  readonly service: OutboxService;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: Array<{ eventName: string; payload: unknown }> = [];
  const append = vi.fn(
    async (_tx: unknown, args: { eventName: string; eventId?: string; payload: unknown }) => {
      calls.push({ eventName: args.eventName, payload: args.payload });
      return {
        kind: 'appended' as const,
        eventId: args.eventId ?? 'evt',
        eventName: args.eventName,
        occurredAt: new Date(),
      };
    },
  );
  return { calls, service: { append } as unknown as OutboxService };
}

// ─── Fake Prisma ───────────────────────────────────────────────────────────

interface ProviderRow {
  id: string;
  userId: string;
  deletedAt: Date | null;
}
interface ConnectionRow {
  id: string;
  providerId: string;
  status: 'connected' | 'error';
  connectedAccountEmail: string | null;
  grantedScope: string | null;
  refreshTokenCiphertext: Buffer;
  refreshTokenIv: Buffer;
  refreshTokenAuthTag: Buffer;
  refreshTokenKeyVersion: number;
  lastSyncedAt: Date | null;
  lastSyncError: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface BusyRow {
  providerId: string;
  startsAt: Date;
  endsAt: Date;
}

class FakePrisma {
  providers: ProviderRow[] = [];
  connection: ConnectionRow | null = null;
  busy: BusyRow[] = [];

  provider = {
    findUnique: vi.fn(async (args: { where: { id?: string; userId?: string } }) => {
      if (args.where.id !== undefined) {
        return this.providers.find((p) => p.id === args.where.id) ?? null;
      }
      return this.providers.find((p) => p.userId === args.where.userId) ?? null;
    }),
  };

  providerCalendarConnection = {
    findUnique: vi.fn(async (args: { where: { providerId: string } }) =>
      this.connection !== null && this.connection.providerId === args.where.providerId
        ? this.connection
        : null,
    ),
    upsert: vi.fn(
      async (args: {
        where: { providerId: string };
        create: Omit<ConnectionRow, 'id' | 'createdAt' | 'updatedAt'>;
        update: Partial<ConnectionRow>;
      }) => {
        if (this.connection !== null && this.connection.providerId === args.where.providerId) {
          this.connection = { ...this.connection, ...args.update, updatedAt: new Date() };
        } else {
          this.connection = {
            ...args.create,
            id: 'conn_1',
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }
        return this.connection;
      },
    ),
    update: vi.fn(async (args: { where: { providerId: string }; data: Partial<ConnectionRow> }) => {
      if (this.connection === null) throw new Error('not found');
      this.connection = { ...this.connection, ...args.data, updatedAt: new Date() };
      return this.connection;
    }),
    delete: vi.fn(async (_args: { where: { providerId: string } }) => {
      const removed = this.connection;
      this.connection = null;
      return removed;
    }),
  };

  providerCalendarExternalBusy = {
    findMany: vi.fn(async (args: { where: { providerId: string } }) =>
      this.busy
        .filter((b) => b.providerId === args.where.providerId)
        .map((b) => ({ startsAt: b.startsAt, endsAt: b.endsAt })),
    ),
    count: vi.fn(
      async (args: { where: { providerId: string } }) =>
        this.busy.filter((b) => b.providerId === args.where.providerId).length,
    ),
    deleteMany: vi.fn(async (args: { where: { providerId: string } }) => {
      const before = this.busy.length;
      this.busy = this.busy.filter((b) => b.providerId !== args.where.providerId);
      return { count: before - this.busy.length };
    }),
    createMany: vi.fn(async (args: { data: BusyRow[] }) => {
      this.busy.push(...args.data);
      return { count: args.data.length };
    }),
  };

  $transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(this));

  asService(): PrismaService {
    return this as unknown as PrismaService;
  }
}

// ─── Fake Google port ──────────────────────────────────────────────────────

function buildGoogle(overrides: Partial<GoogleCalendarPort> = {}): GoogleCalendarPort {
  const tokens: GoogleCalendarTokens = {
    refreshToken: '1//refresh-token',
    scope: 'https://www.googleapis.com/auth/calendar.freebusy openid email',
    accountEmail: 'chef@gmail.com',
  };
  const busy: ExternalBusyInterval[] = [
    { startAt: new Date('2026-05-29T18:00:00.000Z'), endAt: new Date('2026-05-29T19:00:00.000Z') },
  ];
  return {
    buildAuthorizationUrl: vi.fn(
      (_config, input: { state: string }) =>
        `https://accounts.google.com/o/oauth2/v2/auth?state=${encodeURIComponent(input.state)}`,
    ),
    exchangeCode: vi.fn(async () => tokens),
    queryBusyIntervals: vi.fn(async () => busy),
    revokeRefreshToken: vi.fn(async () => undefined),
    ...overrides,
  };
}

// ─── Metrics spy (TS-206-followup-8) ─────────────────────────────────────────

interface MetricsSpy {
  readonly connect: CalendarConnectOutcome[];
  readonly sync: CalendarSyncOutcome[];
  readonly disconnect: CalendarDisconnectOutcome[];
  readonly busy: Array<{ phase: 'connect' | 'sync'; count: number }>;
  readonly metrics: CalendarSyncMetrics;
}
function buildMetricsSpy(): MetricsSpy {
  const connect: CalendarConnectOutcome[] = [];
  const sync: CalendarSyncOutcome[] = [];
  const disconnect: CalendarDisconnectOutcome[] = [];
  const busy: Array<{ phase: 'connect' | 'sync'; count: number }> = [];
  const metrics = {
    recordConnect: (outcome: CalendarConnectOutcome) => connect.push(outcome),
    recordSync: (outcome: CalendarSyncOutcome) => sync.push(outcome),
    recordDisconnect: (outcome: CalendarDisconnectOutcome) => disconnect.push(outcome),
    recordExternalBusyIntervals: (phase: 'connect' | 'sync', count: number) =>
      busy.push({ phase, count }),
  } as unknown as CalendarSyncMetrics;
  return { connect, sync, disconnect, busy, metrics };
}

// ─── Harness ────────────────────────────────────────────────────────────────

function build(opts: { env?: Partial<Env>; google?: Partial<GoogleCalendarPort> } = {}): {
  service: CalendarSyncService;
  prisma: FakePrisma;
  outbox: FakeOutbox;
  google: GoogleCalendarPort;
  env: Env;
  metrics: MetricsSpy;
} {
  const env = buildEnv(opts.env);
  const prisma = new FakePrisma();
  const outbox = buildFakeOutbox();
  const google = buildGoogle(opts.google);
  const cipher = new CalendarTokenCipherService(env);
  const metrics = buildMetricsSpy();
  const service = new CalendarSyncService(
    prisma.asService(),
    outbox.service,
    cipher,
    google,
    env,
    metrics.metrics,
  );
  return { service, prisma, outbox, google, env, metrics };
}

const PROVIDER: ProviderRow = { id: 'prov_1', userId: 'user_1', deletedAt: null };

function seedConnection(prisma: FakePrisma, env: Env): void {
  const cipher = new CalendarTokenCipherService(env);
  const enc = cipher.encrypt('1//refresh-token');
  prisma.connection = {
    id: 'conn_1',
    providerId: 'prov_1',
    status: 'connected',
    connectedAccountEmail: 'chef@gmail.com',
    grantedScope: 'freebusy',
    refreshTokenCiphertext: enc.ciphertext,
    refreshTokenIv: enc.iv,
    refreshTokenAuthTag: enc.authTag,
    refreshTokenKeyVersion: enc.keyVersion,
    lastSyncedAt: new Date('2026-05-29T00:00:00.000Z'),
    lastSyncError: null,
    createdAt: new Date('2026-05-28T00:00:00.000Z'),
    updatedAt: new Date('2026-05-29T00:00:00.000Z'),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CalendarSyncService.resolveConfig / not_configured', () => {
  it('returns not_configured when the Google OAuth client id is unset', async () => {
    const { service, prisma } = build({ env: { GOOGLE_CALENDAR_OAUTH_CLIENT_ID: undefined } });
    prisma.providers = [PROVIDER];
    const result = await service.startConnection({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_configured');
  });

  it('returns not_configured when the cipher key is unset', async () => {
    const { service, prisma } = build({ env: { CALENDAR_TOKEN_ENC_KEY: undefined } });
    prisma.providers = [PROVIDER];
    const result = await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_configured');
  });
});

describe('CalendarSyncService.startConnection', () => {
  it('returns the consent URL for an owned provider', async () => {
    const { service, prisma, google } = build();
    prisma.providers = [PROVIDER];
    const result = await service.startConnection({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.authorizationUrl).toContain('accounts.google.com');
    expect(google.buildAuthorizationUrl).toHaveBeenCalledTimes(1);
  });

  it('returns not_found when the provider does not exist', async () => {
    const { service } = build();
    const result = await service.startConnection({ providerId: 'ghost', actorUserId: 'user_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_found');
  });

  it('returns forbidden when the actor does not own the provider', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    const result = await service.startConnection({
      providerId: 'prov_1',
      actorUserId: 'someone_else',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('forbidden');
  });
});

describe('CalendarSyncService.completeConnection', () => {
  function validState(): string {
    return signOAuthState(STATE_SECRET, {
      providerId: 'prov_1',
      actorUserId: 'user_1',
      nonce: 'n',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  }

  it('persists the connection + busy mirror + emits the event on success', async () => {
    const { service, prisma, outbox } = build();
    prisma.providers = [PROVIDER];
    const outcome = await service.completeConnection({ state: validState(), code: 'auth_code' });
    expect(outcome.kind).toBe('redirect');
    if (outcome.kind === 'redirect') expect(outcome.url).toContain('calendar=connected');
    expect(prisma.connection?.status).toBe('connected');
    // Token is stored encrypted (ciphertext != plaintext).
    expect(prisma.connection?.refreshTokenCiphertext.toString('utf8')).not.toContain(
      'refresh-token',
    );
    expect(prisma.busy.length).toBe(1);
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.eventName).toBe(PROVIDER_CALENDAR_SYNCED);
  });

  it('rejects a forged / expired state with invalid_state (no redirect)', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    const outcome = await service.completeConnection({ state: 'forged.token', code: 'x' });
    expect(outcome.kind).toBe('invalid_state');
    expect(prisma.connection).toBeNull();
  });

  it('redirects with an error banner when consent was declined', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    const outcome = await service.completeConnection({
      state: validState(),
      error: 'access_denied',
    });
    expect(outcome.kind).toBe('redirect');
    if (outcome.kind === 'redirect') {
      expect(outcome.url).toContain('calendar=error');
      expect(outcome.url).toContain('reason=consent_declined');
    }
    expect(prisma.connection).toBeNull();
  });

  it('persists status=error when the initial sync fails but the token is valid', async () => {
    const { service, prisma } = build({
      google: {
        queryBusyIntervals: vi.fn(async () => {
          throw new GoogleCalendarError('transient', 'boom');
        }),
      },
    });
    prisma.providers = [PROVIDER];
    const outcome = await service.completeConnection({ state: validState(), code: 'auth_code' });
    expect(outcome.kind).toBe('redirect');
    if (outcome.kind === 'redirect') expect(outcome.url).toContain('calendar=error');
    expect(prisma.connection?.status).toBe('error');
    expect(prisma.connection?.lastSyncError).toBeTruthy();
  });

  it('returns not_configured when the feature is off', async () => {
    const { service } = build({ env: { GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: undefined } });
    const outcome = await service.completeConnection({ state: 'x.y', code: 'z' });
    expect(outcome.kind).toBe('not_configured');
  });
});

describe('CalendarSyncService.syncProvider', () => {
  it('replaces the busy mirror + emits the event on success', async () => {
    const { service, prisma, outbox, env } = build();
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    prisma.busy = [
      {
        providerId: 'prov_1',
        startsAt: new Date('2020-01-01T00:00:00Z'),
        endsAt: new Date('2020-01-01T01:00:00Z'),
      },
    ];
    const result = await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.externalBusyCount).toBe(1);
    // Stale row replaced by the fresh pull.
    expect(prisma.busy).toHaveLength(1);
    expect(prisma.busy[0]?.startsAt.toISOString()).toBe('2026-05-29T18:00:00.000Z');
    expect(prisma.connection?.status).toBe('connected');
    expect(outbox.calls).toHaveLength(1);
  });

  it('returns not_connected when no connection exists', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    const result = await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('not_connected');
  });

  it('marks the connection error + returns sync_auth_rejected on a revoked grant', async () => {
    const { service, prisma, env } = build({
      google: {
        queryBusyIntervals: vi.fn(async () => {
          throw new GoogleCalendarError('auth_rejected', 'invalid_grant');
        }),
      },
    });
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    prisma.busy = [
      {
        providerId: 'prov_1',
        startsAt: new Date('2026-05-29T18:00:00Z'),
        endsAt: new Date('2026-05-29T19:00:00Z'),
      },
    ];
    const result = await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason).toBe('sync_auth_rejected');
    expect(prisma.connection?.status).toBe('error');
    // A transient/auth failure must NOT wipe the still-valid mirror.
    expect(prisma.busy).toHaveLength(1);
  });
});

describe('CalendarSyncService.disconnect', () => {
  it('is an idempotent no-op when nothing is connected', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    const result = await service.disconnect({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.disconnected).toBe(false);
      expect(result.value.removedExternalBusyCount).toBe(0);
    }
  });

  it('revokes, drops the connection + mirror, and emits the event', async () => {
    const { service, prisma, outbox, google, env } = build();
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    prisma.busy = [
      {
        providerId: 'prov_1',
        startsAt: new Date('2026-05-29T18:00:00Z'),
        endsAt: new Date('2026-05-29T19:00:00Z'),
      },
    ];
    const result = await service.disconnect({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.disconnected).toBe(true);
      expect(result.value.removedExternalBusyCount).toBe(1);
    }
    expect(google.revokeRefreshToken).toHaveBeenCalledTimes(1);
    expect(prisma.connection).toBeNull();
    expect(prisma.busy).toHaveLength(0);
    expect(outbox.calls).toHaveLength(1);
    const payload = outbox.calls[0]?.payload as { externalBusyCount: number };
    expect(payload.externalBusyCount).toBe(0);
  });
});

describe('CalendarSyncService reads', () => {
  it('getConnectionByUserId returns null when not connected', async () => {
    const { service, prisma } = build();
    prisma.providers = [PROVIDER];
    expect(await service.getConnectionByUserId('user_1')).toBeNull();
  });

  it('getConnectionByUserId returns the record without any token material', async () => {
    const { service, prisma, env } = build();
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    prisma.busy = [
      {
        providerId: 'prov_1',
        startsAt: new Date('2026-05-29T18:00:00Z'),
        endsAt: new Date('2026-05-29T19:00:00Z'),
      },
    ];
    const record = await service.getConnectionByUserId('user_1');
    expect(record).not.toBeNull();
    expect(record?.externalBusyCount).toBe(1);
    expect(record?.connectedAccountEmail).toBe('chef@gmail.com');
    // The DTO must not carry any token columns.
    expect(JSON.stringify(record)).not.toMatch(/refreshToken|ciphertext/i);
  });

  it('getExternalBusyIntervals returns the mirrored intervals', async () => {
    const { service, prisma } = build();
    prisma.busy = [
      {
        providerId: 'prov_1',
        startsAt: new Date('2026-05-29T18:00:00Z'),
        endsAt: new Date('2026-05-29T19:00:00Z'),
      },
    ];
    const intervals = await service.getExternalBusyIntervals('prov_1');
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.startAt.toISOString()).toBe('2026-05-29T18:00:00.000Z');
  });
});

// ─── Observability (TS-206-followup-8) ───────────────────────────────────────

describe('CalendarSyncService observability', () => {
  function validState(): string {
    return signOAuthState(STATE_SECRET, {
      providerId: 'prov_1',
      actorUserId: 'user_1',
      nonce: 'n',
      exp: Math.floor(Date.now() / 1000) + 600,
    });
  }

  it('records connected + the connect-phase busy count on a successful callback', async () => {
    const { service, prisma, metrics } = build();
    prisma.providers = [PROVIDER];
    await service.completeConnection({ state: validState(), code: 'auth_code' });
    expect(metrics.connect).toEqual(['connected']);
    expect(metrics.busy).toEqual([{ phase: 'connect', count: 1 }]);
  });

  it('records connected_sync_error (busy=0) when the initial pull fails', async () => {
    const { service, prisma, metrics } = build({
      google: {
        queryBusyIntervals: vi.fn(async () => {
          throw new GoogleCalendarError('transient', 'boom');
        }),
      },
    });
    prisma.providers = [PROVIDER];
    await service.completeConnection({ state: validState(), code: 'auth_code' });
    expect(metrics.connect).toEqual(['connected_sync_error']);
    expect(metrics.busy).toEqual([{ phase: 'connect', count: 0 }]);
  });

  it('records consent_declined with no busy sample when consent is declined', async () => {
    const { service, prisma, metrics } = build();
    prisma.providers = [PROVIDER];
    await service.completeConnection({ state: validState(), error: 'access_denied' });
    expect(metrics.connect).toEqual(['consent_declined']);
    expect(metrics.busy).toEqual([]);
  });

  it('records invalid_state on a forged callback state', async () => {
    const { service, prisma, metrics } = build();
    prisma.providers = [PROVIDER];
    await service.completeConnection({ state: 'forged.token', code: 'x' });
    expect(metrics.connect).toEqual(['invalid_state']);
    expect(metrics.busy).toEqual([]);
  });

  it('records not_configured when the feature is dark', async () => {
    const { service, metrics } = build({ env: { GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET: undefined } });
    await service.completeConnection({ state: 'x.y', code: 'z' });
    expect(metrics.connect).toEqual(['not_configured']);
  });

  it('records ok + the sync-phase busy count on a successful re-sync', async () => {
    const { service, prisma, env, metrics } = build();
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(metrics.sync).toEqual(['ok']);
    expect(metrics.busy).toEqual([{ phase: 'sync', count: 1 }]);
  });

  it('records auth_rejected (no busy sample) on a revoked grant', async () => {
    const { service, prisma, env, metrics } = build({
      google: {
        queryBusyIntervals: vi.fn(async () => {
          throw new GoogleCalendarError('auth_rejected', 'invalid_grant');
        }),
      },
    });
    prisma.providers = [PROVIDER];
    seedConnection(prisma, env);
    await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(metrics.sync).toEqual(['auth_rejected']);
    expect(metrics.busy).toEqual([]);
  });

  it('records not_connected when syncing a provider with no connection', async () => {
    const { service, prisma, metrics } = build();
    prisma.providers = [PROVIDER];
    await service.syncProvider({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(metrics.sync).toEqual(['not_connected']);
    expect(metrics.busy).toEqual([]);
  });

  it('records disconnected on a real teardown and already_disconnected on the no-op', async () => {
    const connected = build();
    connected.prisma.providers = [PROVIDER];
    seedConnection(connected.prisma, connected.env);
    await connected.service.disconnect({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(connected.metrics.disconnect).toEqual(['disconnected']);

    const empty = build();
    empty.prisma.providers = [PROVIDER];
    await empty.service.disconnect({ providerId: 'prov_1', actorUserId: 'user_1' });
    expect(empty.metrics.disconnect).toEqual(['already_disconnected']);
  });
});
