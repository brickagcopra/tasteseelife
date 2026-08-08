import type { OutboxService } from '@taste-and-see/nest-outbox';
import { describe, expect, it, vi } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  AvailabilityService,
  resolveNextSevenDays,
  toProviderAvailabilityRecord,
  type ProviderAvailabilitySnapshot,
} from './availability.service';

/**
 * Unit tests for `AvailabilityService` (TS-203).
 *
 * Fakes:
 *   - `FakePrisma` — in-memory store implementing the narrow surface
 *     the service consumes (`provider.findUnique`,
 *     `providerAvailabilityWindow.findMany` / `.deleteMany` /
 *     `.createMany`, `providerAvailabilityException.{findMany,
 *     deleteMany, createMany}`, and a `$transaction` callback that
 *     runs against the same delegates). No transactional rollback
 *     semantics — the integration test against real Postgres
 *     carries the atomic guarantee.
 *   - `FakeOutbox` — records every `append` call so tests assert
 *     event-emission shape.
 */

interface FakeOutboxAppendCall {
  readonly eventName: string;
  readonly eventId: string | undefined;
  readonly payload: unknown;
}
interface FakeOutbox {
  readonly calls: FakeOutboxAppendCall[];
  readonly append: ReturnType<typeof vi.fn>;
  setNextValidationFailure(reason: string): void;
}
function buildFakeOutbox(): FakeOutbox {
  const calls: FakeOutboxAppendCall[] = [];
  let nextFailure: string | null = null;
  const append = vi.fn(
    async (
      _tx: unknown,
      args: { eventName: string; eventId?: string; payload: unknown },
    ): Promise<
      | { kind: 'appended'; eventId: string; eventName: string; occurredAt: Date }
      | {
          kind: 'validation_failed';
          eventName: string;
          issues: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>;
        }
    > => {
      calls.push({
        eventName: args.eventName,
        eventId: args.eventId,
        payload: args.payload,
      });
      if (nextFailure !== null) {
        const failure = nextFailure;
        nextFailure = null;
        return {
          kind: 'validation_failed',
          eventName: args.eventName,
          issues: [{ path: [], message: failure }],
        };
      }
      return {
        kind: 'appended',
        eventId: args.eventId ?? 'evt_fake',
        eventName: args.eventName,
        occurredAt: new Date('2026-05-20T12:00:00.000Z'),
      };
    },
  );
  return {
    calls,
    append,
    setNextValidationFailure(reason) {
      nextFailure = reason;
    },
  };
}
function asOutboxService(fake: FakeOutbox): OutboxService {
  return { append: fake.append } as unknown as OutboxService;
}

interface ProviderRow {
  readonly id: string;
  readonly userId: string;
  readonly timeZone: string;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

interface WindowRow {
  providerId: string;
  weekday: 'sunday' | 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday';
  startTime: Date;
  endTime: Date;
  updatedAt: Date;
}
interface ExceptionRow {
  providerId: string;
  exceptionDate: Date;
  createdAt: Date;
}

class FakePrisma {
  public providers: ProviderRow[] = [];
  public windows: WindowRow[] = [];
  public exceptions: ExceptionRow[] = [];

  provider = {
    findUnique: vi.fn(
      async (args: { where: { id?: string; userId?: string } }): Promise<ProviderRow | null> => {
        if (args.where.id !== undefined) {
          return this.providers.find((p) => p.id === args.where.id) ?? null;
        }
        if (args.where.userId !== undefined) {
          return this.providers.find((p) => p.userId === args.where.userId) ?? null;
        }
        return null;
      },
    ),
  };

  providerAvailabilityWindow = {
    findMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<readonly WindowRow[]> => {
        return this.windows.filter((w) => w.providerId === args.where.providerId);
      },
    ),
    deleteMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<{ count: number }> => {
        const before = this.windows.length;
        this.windows = this.windows.filter((w) => w.providerId !== args.where.providerId);
        return { count: before - this.windows.length };
      },
    ),
    createMany: vi.fn(
      async (args: {
        data: ReadonlyArray<{
          providerId: string;
          weekday: WindowRow['weekday'];
          startTime: Date;
          endTime: Date;
        }>;
      }): Promise<{ count: number }> => {
        const updatedAt = new Date('2026-05-20T12:00:00.000Z');
        for (const row of args.data) {
          this.windows.push({ ...row, updatedAt });
        }
        return { count: args.data.length };
      },
    ),
  };

  providerAvailabilityException = {
    findMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<readonly ExceptionRow[]> => {
        return this.exceptions.filter((e) => e.providerId === args.where.providerId);
      },
    ),
    deleteMany: vi.fn(
      async (args: { where: { providerId: string } }): Promise<{ count: number }> => {
        const before = this.exceptions.length;
        this.exceptions = this.exceptions.filter((e) => e.providerId !== args.where.providerId);
        return { count: before - this.exceptions.length };
      },
    ),
    createMany: vi.fn(
      async (args: {
        data: ReadonlyArray<{ providerId: string; exceptionDate: Date }>;
      }): Promise<{ count: number }> => {
        const createdAt = new Date('2026-05-20T12:00:00.000Z');
        for (const row of args.data) {
          this.exceptions.push({ ...row, createdAt });
        }
        return { count: args.data.length };
      },
    ),
  };

  $transaction = vi.fn(
    async <T>(
      fn: (tx: {
        providerAvailabilityWindow: FakePrisma['providerAvailabilityWindow'];
        providerAvailabilityException: FakePrisma['providerAvailabilityException'];
      }) => Promise<T>,
    ): Promise<T> => {
      return fn({
        providerAvailabilityWindow: this.providerAvailabilityWindow,
        providerAvailabilityException: this.providerAvailabilityException,
      });
    },
  );
}

function buildPrisma(): FakePrisma {
  return new FakePrisma();
}

const NOW = new Date('2026-05-20T12:00:00.000Z');

function aProviderRow(overrides: Partial<ProviderRow> = {}): ProviderRow {
  return {
    id: 'prov_1',
    userId: 'user_self',
    timeZone: 'America/New_York',
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

/**
 * UTC midnight + HH:MM is how Prisma's `@db.Time(0)` round-trips —
 * the fake stores the same kind of value the production driver
 * would return.
 */
function timeOfDay(hh: number, mm: number): Date {
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0, 0));
}

function calendarDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
}

describe('AvailabilityService.updateAvailability', () => {
  it('replaces the window + exception sets and emits the outbox event', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.windows = [
      {
        providerId: 'prov_1',
        weekday: 'monday',
        startTime: timeOfDay(9, 0),
        endTime: timeOfDay(13, 0),
        updatedAt: NOW,
      },
    ];
    prisma.exceptions = [
      {
        providerId: 'prov_1',
        exceptionDate: calendarDate(2026, 5, 24),
        createdAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      windows: [
        { weekday: 'monday', startTime: '10:00', endTime: '14:00' },
        { weekday: 'wednesday', startTime: '18:00', endTime: '21:00' },
      ],
      exceptions: [{ date: '2026-12-25' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toHaveLength(2);
    expect(result.value.windows[0]?.weekday).toBe('monday');
    expect(result.value.windows[0]?.startTime).toBe('10:00');
    expect(result.value.windows[1]?.weekday).toBe('wednesday');
    expect(result.value.exceptions).toEqual([{ date: '2026-12-25' }]);
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.eventName).toBe('provider.availability_updated');
    expect(outbox.calls[0]?.payload).toMatchObject({
      providerId: 'prov_1',
      windowCount: 2,
      exceptionCount: 1,
      actorUserId: 'user_self',
    });
  });

  it('accepts an empty-everything PUT (clear-all)', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.windows = [
      {
        providerId: 'prov_1',
        weekday: 'monday',
        startTime: timeOfDay(9, 0),
        endTime: timeOfDay(13, 0),
        updatedAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      windows: [],
      exceptions: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.windows).toEqual([]);
    expect(result.value.exceptions).toEqual([]);
    expect(prisma.windows).toEqual([]);
    expect(outbox.calls).toHaveLength(1);
    expect(outbox.calls[0]?.payload).toMatchObject({ windowCount: 0, exceptionCount: 0 });
  });

  it('rejects an empty providerId at the boundary', async () => {
    const prisma = buildPrisma();
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: '',
      actorUserId: 'user_self',
      windows: [],
      exceptions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('invalid_request');
  });

  it('returns not_found when the provider row is missing', async () => {
    const prisma = buildPrisma();
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_missing',
      actorUserId: 'user_self',
      windows: [],
      exceptions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns not_found when the provider is soft-deleted', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ deletedAt: new Date('2026-05-10T00:00:00.000Z') })];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      windows: [],
      exceptions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('not_found');
  });

  it('returns forbidden when the actor does not own the row', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ userId: 'someone_else' })];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      windows: [],
      exceptions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    expect(outbox.calls).toHaveLength(0);
  });

  it('rolls back when the outbox emit fails validation', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    outbox.setNextValidationFailure('payload too small');
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.updateAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
      windows: [{ weekday: 'monday', startTime: '09:00', endTime: '13:00' }],
      exceptions: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('outbox_validation_failed');
    if (result.error.reason !== 'outbox_validation_failed') return;
    expect(result.error.eventName).toBe('provider.availability_updated');
  });
});

describe('AvailabilityService.deleteAvailability', () => {
  it('clears every row + emits the outbox event when something was deleted', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.windows = [
      {
        providerId: 'prov_1',
        weekday: 'monday',
        startTime: timeOfDay(9, 0),
        endTime: timeOfDay(13, 0),
        updatedAt: NOW,
      },
      {
        providerId: 'prov_1',
        weekday: 'wednesday',
        startTime: timeOfDay(18, 0),
        endTime: timeOfDay(21, 0),
        updatedAt: NOW,
      },
    ];
    prisma.exceptions = [
      {
        providerId: 'prov_1',
        exceptionDate: calendarDate(2026, 12, 25),
        createdAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedWindowCount).toBe(2);
    expect(result.value.deletedExceptionCount).toBe(1);
    expect(prisma.windows).toEqual([]);
    expect(prisma.exceptions).toEqual([]);
    expect(outbox.calls).toHaveLength(1);
  });

  it('no-op delete on already-empty schedule (no outbox emission)', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deletedWindowCount).toBe(0);
    expect(result.value.deletedExceptionCount).toBe(0);
    expect(outbox.calls).toHaveLength(0);
  });

  it('returns forbidden when the actor does not own the row', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ userId: 'someone_else' })];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const result = await svc.deleteAvailability({
      providerId: 'prov_1',
      actorUserId: 'user_self',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.reason).toBe('forbidden');
    expect(outbox.calls).toHaveLength(0);
  });
});

describe('AvailabilityService.getAvailability', () => {
  it('returns the materialised snapshot with sorted windows + exceptions', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow()];
    prisma.windows = [
      // Insert out of order to verify the service sorts on read.
      {
        providerId: 'prov_1',
        weekday: 'wednesday',
        startTime: timeOfDay(18, 0),
        endTime: timeOfDay(21, 0),
        updatedAt: NOW,
      },
      {
        providerId: 'prov_1',
        weekday: 'monday',
        startTime: timeOfDay(9, 0),
        endTime: timeOfDay(13, 0),
        updatedAt: NOW,
      },
    ];
    prisma.exceptions = [
      {
        providerId: 'prov_1',
        exceptionDate: calendarDate(2026, 12, 25),
        createdAt: NOW,
      },
      {
        providerId: 'prov_1',
        exceptionDate: calendarDate(2026, 11, 27),
        createdAt: NOW,
      },
    ];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const snapshot = await svc.getAvailability('prov_1');
    expect(snapshot).not.toBeNull();
    if (snapshot === null) return;
    expect(snapshot.windows).toEqual([
      { weekday: 'monday', startTime: '09:00', endTime: '13:00' },
      { weekday: 'wednesday', startTime: '18:00', endTime: '21:00' },
    ]);
    expect(snapshot.exceptions).toEqual([{ date: '2026-11-27' }, { date: '2026-12-25' }]);
  });

  it('returns null for a soft-deleted provider', async () => {
    const prisma = buildPrisma();
    prisma.providers = [aProviderRow({ deletedAt: new Date('2026-05-10T00:00:00.000Z') })];
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const snapshot = await svc.getAvailability('prov_1');
    expect(snapshot).toBeNull();
  });

  it('returns null for a missing provider', async () => {
    const prisma = buildPrisma();
    const outbox = buildFakeOutbox();
    const svc = new AvailabilityService(
      prisma as unknown as PrismaService,
      asOutboxService(outbox),
    );

    const snapshot = await svc.getAvailability('prov_missing');
    expect(snapshot).toBeNull();
  });
});

describe('resolveNextSevenDays', () => {
  it('emits one entry per matching weekday in the next 7 days', () => {
    // 2026-05-20 is a Wednesday — the 7-day window covers Wed→Tue.
    const entries = resolveNextSevenDays({
      from: new Date(Date.UTC(2026, 4, 20)),
      windows: [
        { weekday: 'wednesday', startTime: '09:00', endTime: '13:00' },
        { weekday: 'friday', startTime: '18:00', endTime: '21:00' },
        // Saturday + Sunday — appear once each in the window.
        { weekday: 'sunday', startTime: '12:00', endTime: '15:00' },
      ],
      exceptions: [],
    });
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.weekday)).toEqual(['wednesday', 'friday', 'sunday']);
    expect(entries[0]?.date).toBe('2026-05-20');
  });

  it('skips dates covered by an exclusion', () => {
    const entries = resolveNextSevenDays({
      from: new Date(Date.UTC(2026, 4, 20)),
      windows: [{ weekday: 'wednesday', startTime: '09:00', endTime: '13:00' }],
      exceptions: [{ date: '2026-05-20' }],
    });
    expect(entries).toEqual([]);
  });

  it('returns multiple windows per weekday (split shifts)', () => {
    const entries = resolveNextSevenDays({
      from: new Date(Date.UTC(2026, 4, 20)),
      windows: [
        { weekday: 'wednesday', startTime: '09:00', endTime: '13:00' },
        { weekday: 'wednesday', startTime: '18:00', endTime: '21:00' },
      ],
      exceptions: [],
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.startTime).toBe('09:00');
    expect(entries[1]?.startTime).toBe('18:00');
  });

  it('returns no entries when windows are empty', () => {
    const entries = resolveNextSevenDays({
      from: new Date(Date.UTC(2026, 4, 20)),
      windows: [],
      exceptions: [{ date: '2026-05-25' }],
    });
    expect(entries).toEqual([]);
  });
});

describe('toProviderAvailabilityRecord', () => {
  it('projects the snapshot to the contract shape', () => {
    const snapshot: ProviderAvailabilitySnapshot = {
      providerId: 'prov_1',
      timeZone: 'America/New_York',
      windows: [{ weekday: 'monday', startTime: '09:00', endTime: '13:00' }],
      exceptions: [{ date: '2026-12-25' }],
      updatedAt: NOW,
    };
    const record = toProviderAvailabilityRecord(snapshot);
    expect(record.providerId).toBe('prov_1');
    expect(record.timeZone).toBe('America/New_York');
    expect(record.windows).toEqual([{ weekday: 'monday', startTime: '09:00', endTime: '13:00' }]);
    expect(record.exceptions).toEqual([{ date: '2026-12-25' }]);
    expect(record.updatedAt).toBe(NOW.toISOString());
  });
});
