import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import {
  CATEGORIES,
  CHANNELS,
  DuplicatePreferenceEntryError,
  PreferencesService,
  computeDefault,
} from './preferences.service';

type Channel = 'email' | 'sms' | 'push' | 'in_app';
type Category = 'transactional' | 'marketing' | 'system';

interface PreferenceRow {
  userId: string;
  channel: Channel;
  category: Category;
  optIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface ProfileRow {
  userId: string;
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
  timeZone: string | null;
  seniorMode: boolean;
  globallyUnsubscribed: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * In-memory FakePrisma for PreferencesService unit tests. Mirrors the
 * shape used by TemplatesService — implements only the methods the
 * service actually calls. The integration suite (TS-073-followup) will
 * exercise real Postgres semantics.
 */
class FakePrisma {
  preferences: PreferenceRow[] = [];
  profiles: ProfileRow[] = [];

  notificationPreference = {
    findUnique: async ({
      where,
    }: {
      where: {
        userId_channel_category: { userId: string; channel: Channel; category: Category };
      };
    }): Promise<{ optIn: boolean } | null> => {
      const k = where.userId_channel_category;
      const row = this.preferences.find(
        (r) => r.userId === k.userId && r.channel === k.channel && r.category === k.category,
      );
      return row ? { optIn: row.optIn } : null;
    },

    findMany: async ({
      where,
    }: {
      where: { userId: string };
    }): Promise<
      Array<{ channel: Channel; category: Category; optIn: boolean; updatedAt: Date }>
    > => {
      return this.preferences
        .filter((r) => r.userId === where.userId)
        .map(({ channel, category, optIn, updatedAt }) => ({
          channel,
          category,
          optIn,
          updatedAt,
        }));
    },

    deleteMany: async ({ where }: { where: { userId: string } }): Promise<{ count: number }> => {
      const before = this.preferences.length;
      this.preferences = this.preferences.filter((r) => r.userId !== where.userId);
      return { count: before - this.preferences.length };
    },

    createMany: async ({
      data,
    }: {
      data: Array<{ userId: string; channel: Channel; category: Category; optIn: boolean }>;
    }): Promise<{ count: number }> => {
      const now = new Date();
      for (const row of data) {
        this.preferences.push({ ...row, createdAt: now, updatedAt: now });
      }
      return { count: data.length };
    },
  };

  notificationUserPreferenceProfile = {
    findUnique: async ({ where }: { where: { userId: string } }): Promise<ProfileRow | null> => {
      return this.profiles.find((p) => p.userId === where.userId) ?? null;
    },

    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { userId: string };
      create: Partial<ProfileRow> & { userId: string };
      update: Partial<ProfileRow>;
    }): Promise<ProfileRow> => {
      const existing = this.profiles.find((p) => p.userId === where.userId);
      const now = new Date();
      if (existing) {
        Object.assign(existing, update, { updatedAt: now });
        return existing;
      }
      const row: ProfileRow = {
        quietHoursStartMinute: null,
        quietHoursEndMinute: null,
        timeZone: null,
        seniorMode: false,
        globallyUnsubscribed: false,
        createdAt: now,
        updatedAt: now,
        ...create,
        userId: where.userId,
      };
      this.profiles.push(row);
      return row;
    },
  };

  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => {
    return fn(this);
  };
}

function makeService(): { service: PreferencesService; fake: FakePrisma } {
  const fake = new FakePrisma();
  const service = new PreferencesService(fake as unknown as PrismaService);
  return { service, fake };
}

describe('computeDefault', () => {
  it('opts in transactional and system across every channel for non-senior users', () => {
    for (const channel of CHANNELS) {
      for (const category of CATEGORIES) {
        if (category === 'marketing') continue;
        expect(computeDefault(channel, category, false)).toBe(true);
      }
    }
  });

  it('opts out marketing on off-platform channels for non-senior users', () => {
    expect(computeDefault('email', 'marketing', false)).toBe(false);
    expect(computeDefault('sms', 'marketing', false)).toBe(false);
    expect(computeDefault('push', 'marketing', false)).toBe(false);
  });

  it('opts in marketing in_app for non-senior users (banner is fair game)', () => {
    expect(computeDefault('in_app', 'marketing', false)).toBe(true);
  });

  it('opts out every marketing channel for senior-mode users', () => {
    for (const channel of CHANNELS) {
      expect(computeDefault(channel, 'marketing', true)).toBe(false);
    }
  });
});

describe('PreferencesService.getForUser', () => {
  it('returns the full 12-entry matrix with defaults when no rows exist', async () => {
    const { service } = makeService();
    const result = await service.getForUser('user_abc');
    expect(result.entries).toHaveLength(12);
    expect(result.entries.every((e) => e.explicit === false)).toBe(true);
    expect(result.quietHours).toBeNull();
    expect(result.seniorMode).toBe(false);
    expect(result.globallyUnsubscribed).toBe(false);
    expect(result.updatedAt).toBeNull();
  });

  it('marks explicit overrides as explicit:true', async () => {
    const { service, fake } = makeService();
    fake.preferences.push({
      userId: 'user_abc',
      channel: 'sms',
      category: 'marketing',
      optIn: true,
      createdAt: new Date('2026-05-16T10:00:00Z'),
      updatedAt: new Date('2026-05-16T10:00:00Z'),
    });
    const result = await service.getForUser('user_abc');
    const row = result.entries.find((e) => e.channel === 'sms' && e.category === 'marketing');
    expect(row).toMatchObject({ optIn: true, explicit: true });
  });

  it('returns the configured quiet-hours window', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: 1260,
      quietHoursEndMinute: 480,
      timeZone: 'America/New_York',
      seniorMode: false,
      globallyUnsubscribed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.getForUser('user_abc');
    expect(result.quietHours).toEqual({
      startMinuteOfDay: 1260,
      endMinuteOfDay: 480,
      timeZone: 'America/New_York',
    });
  });

  it('applies senior-mode marketing-off defaults when seniorMode = true', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      timeZone: null,
      seniorMode: true,
      globallyUnsubscribed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.getForUser('user_abc');
    const marketing = result.entries.filter((e) => e.category === 'marketing');
    expect(marketing.every((e) => e.optIn === false)).toBe(true);
  });
});

describe('PreferencesService.getEffectivePreference', () => {
  it('returns the explicit row when present', async () => {
    const { service, fake } = makeService();
    fake.preferences.push({
      userId: 'user_abc',
      channel: 'email',
      category: 'marketing',
      optIn: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.getEffectivePreference('user_abc', 'email', 'marketing');
    expect(result).toMatchObject({ optIn: true, explicit: true });
  });

  it('falls back to the senior-mode-aware default when no row exists', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      timeZone: null,
      seniorMode: true,
      globallyUnsubscribed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.getEffectivePreference('user_abc', 'email', 'marketing');
    expect(result).toMatchObject({ optIn: false, explicit: false, seniorMode: true });
  });

  it('reports globallyUnsubscribed from the profile row', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      timeZone: null,
      seniorMode: false,
      globallyUnsubscribed: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.getEffectivePreference('user_abc', 'email', 'transactional');
    expect(result.globallyUnsubscribed).toBe(true);
  });
});

describe('PreferencesService.upsertForUser', () => {
  it('replaces existing rows with the supplied entries', async () => {
    const { service, fake } = makeService();
    fake.preferences.push({
      userId: 'user_abc',
      channel: 'email',
      category: 'marketing',
      optIn: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.upsertForUser('user_abc', {
      entries: [{ channel: 'sms', category: 'transactional', optIn: false }],
    });

    expect(fake.preferences).toHaveLength(1);
    expect(fake.preferences[0]).toMatchObject({
      channel: 'sms',
      category: 'transactional',
      optIn: false,
    });
    expect(
      result.entries.find((e) => e.channel === 'sms' && e.category === 'transactional')?.optIn,
    ).toBe(false);
    // The previously-explicit (email, marketing) row was wiped — falls
    // back to default.
    expect(
      result.entries.find((e) => e.channel === 'email' && e.category === 'marketing'),
    ).toMatchObject({ optIn: false, explicit: false });
  });

  it('upserts the quiet-hours window when supplied', async () => {
    const { service, fake } = makeService();
    await service.upsertForUser('user_abc', {
      entries: [],
      quietHours: {
        startMinuteOfDay: 1260,
        endMinuteOfDay: 480,
        timeZone: 'America/New_York',
      },
    });
    expect(fake.profiles).toHaveLength(1);
    expect(fake.profiles[0]).toMatchObject({
      quietHoursStartMinute: 1260,
      quietHoursEndMinute: 480,
      timeZone: 'America/New_York',
    });
  });

  it('clears the quiet-hours window when quietHours = null', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: 1260,
      quietHoursEndMinute: 480,
      timeZone: 'America/New_York',
      seniorMode: false,
      globallyUnsubscribed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await service.upsertForUser('user_abc', { entries: [], quietHours: null });
    expect(fake.profiles[0]).toMatchObject({
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      timeZone: null,
    });
  });

  it('leaves quiet-hours untouched when quietHours is omitted', async () => {
    const { service, fake } = makeService();
    fake.profiles.push({
      userId: 'user_abc',
      quietHoursStartMinute: 1260,
      quietHoursEndMinute: 480,
      timeZone: 'America/New_York',
      seniorMode: true,
      globallyUnsubscribed: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await service.upsertForUser('user_abc', { entries: [] });
    expect(result.quietHours).toEqual({
      startMinuteOfDay: 1260,
      endMinuteOfDay: 480,
      timeZone: 'America/New_York',
    });
    expect(result.seniorMode).toBe(true);
  });

  it('rejects duplicate entries before any DB write', async () => {
    const { service, fake } = makeService();
    fake.preferences.push({
      userId: 'user_abc',
      channel: 'email',
      category: 'marketing',
      optIn: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      service.upsertForUser('user_abc', {
        entries: [
          { channel: 'email', category: 'marketing', optIn: false },
          { channel: 'email', category: 'marketing', optIn: true },
        ],
      }),
    ).rejects.toBeInstanceOf(DuplicatePreferenceEntryError);
    // The pre-existing row is intact — duplicate detection runs before
    // the deleteMany().
    expect(fake.preferences).toHaveLength(1);
  });
});

describe('PreferencesService.setSeniorMode / setGloballyUnsubscribed', () => {
  it('creates the profile row on first call', async () => {
    const { service, fake } = makeService();
    await service.setSeniorMode('user_abc', true);
    expect(fake.profiles).toHaveLength(1);
    expect(fake.profiles[0]).toMatchObject({ userId: 'user_abc', seniorMode: true });
  });

  it('updates the profile row when one already exists', async () => {
    const { service, fake } = makeService();
    await service.setGloballyUnsubscribed('user_abc', true);
    await service.setSeniorMode('user_abc', true);
    expect(fake.profiles).toHaveLength(1);
    expect(fake.profiles[0]).toMatchObject({
      globallyUnsubscribed: true,
      seniorMode: true,
    });
  });
});
