import { describe, expect, it } from 'vitest';

import { PreferenceGateService } from './preference-gate.service';
import { QuietHoursService } from './quiet-hours.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { PreferencesService } from '../../preferences/services/preferences.service';

interface ProfileRow {
  quietHoursStartMinute: number | null;
  quietHoursEndMinute: number | null;
  timeZone: string | null;
}

class FakePrisma {
  profiles: Map<string, ProfileRow> = new Map();

  notificationUserPreferenceProfile = {
    findUnique: async ({ where }: { where: { userId: string } }): Promise<ProfileRow | null> => {
      return this.profiles.get(where.userId) ?? null;
    },
  };
}

function makeService(opts: {
  optIn: boolean;
  globallyUnsubscribed?: boolean;
  quietHoursWindow?: ProfileRow;
}): {
  service: PreferenceGateService;
  fake: FakePrisma;
} {
  const fakePrisma = new FakePrisma();
  if (opts.quietHoursWindow) {
    fakePrisma.profiles.set('user_abc', opts.quietHoursWindow);
  }

  const fakePreferences = {
    getEffectivePreference: async (): Promise<{
      optIn: boolean;
      explicit: boolean;
      globallyUnsubscribed: boolean;
      seniorMode: boolean;
    }> => ({
      optIn: opts.optIn,
      explicit: false,
      globallyUnsubscribed: opts.globallyUnsubscribed ?? false,
      seniorMode: false,
    }),
  } as unknown as PreferencesService;

  const service = new PreferenceGateService(
    fakePreferences,
    new QuietHoursService(),
    fakePrisma as unknown as PrismaService,
  );
  return { service, fake: fakePrisma };
}

const now = new Date('2026-05-16T03:00:00Z'); // 23:00 EDT — inside NYC 21:00-08:00 window
const nightTime = new Date('2026-05-16T03:00:00Z'); // same
const dayTime = new Date('2026-05-16T16:00:00Z'); // 12:00 EDT

describe('PreferenceGateService.decide', () => {
  it('suppresses on globally_unsubscribed', async () => {
    const { service } = makeService({ optIn: true, globallyUnsubscribed: true });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'transactional',
        bypassQuietHours: true,
      },
      now,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'globally_unsubscribed' });
  });

  it('suppresses on preference opt-out', async () => {
    const { service } = makeService({ optIn: false });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'sms',
        category: 'marketing',
        bypassQuietHours: false,
      },
      now,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'preference_opted_out' });
  });

  it('suppresses on quiet hours when no bypass', async () => {
    const { service } = makeService({
      optIn: true,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'sms',
        category: 'transactional',
        bypassQuietHours: false,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'quiet_hours' });
  });

  it('allows when bypass is requested for transactional', async () => {
    const { service } = makeService({
      optIn: true,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'sms',
        category: 'transactional',
        bypassQuietHours: true,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('refuses bypass for marketing (only transactional can bypass)', async () => {
    const { service } = makeService({
      optIn: true,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'marketing',
        bypassQuietHours: true,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'quiet_hours' });
  });

  it('refuses bypass for system category', async () => {
    const { service } = makeService({
      optIn: true,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'system',
        bypassQuietHours: true,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'quiet_hours' });
  });

  it('allows when outside the quiet-hours window', async () => {
    const { service } = makeService({
      optIn: true,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'transactional',
        bypassQuietHours: false,
      },
      dayTime,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('allows when no quiet-hours window is configured', async () => {
    const { service } = makeService({ optIn: true });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'marketing',
        bypassQuietHours: false,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: true });
  });

  it('prefers globally_unsubscribed over opt-out (kill-switch wins)', async () => {
    const { service } = makeService({ optIn: false, globallyUnsubscribed: true });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'transactional',
        bypassQuietHours: false,
      },
      now,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'globally_unsubscribed' });
  });

  it('prefers opt-out over quiet hours', async () => {
    const { service } = makeService({
      optIn: false,
      quietHoursWindow: {
        quietHoursStartMinute: 1260,
        quietHoursEndMinute: 480,
        timeZone: 'America/New_York',
      },
    });
    const decision = await service.decide(
      {
        recipientUserId: 'user_abc',
        channel: 'email',
        category: 'transactional',
        bypassQuietHours: false,
      },
      nightTime,
    );
    expect(decision).toEqual({ allow: false, suppressionReason: 'preference_opted_out' });
  });
});
