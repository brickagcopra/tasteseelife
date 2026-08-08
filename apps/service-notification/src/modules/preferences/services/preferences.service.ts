import { Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannelKind,
  PreferenceEntry,
  QuietHoursWindow,
  ResolvedPreferenceEntry,
  UpsertPreferencesRequest,
} from '@taste-and-see/contracts';

import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

/**
 * Notification preferences orchestration (TS-073).
 *
 * Owns the per-user preference matrix that the dispatch orchestrator
 * consults before invoking a channel adapter:
 *
 *   1. **Per-`(channel, category)` opt-in rows** in
 *      `notification.notification_preferences`. The user manages these
 *      via `PUT /api/v1/notification/preferences` (full-replace
 *      semantics). Missing rows fall back to the senior-mode-aware
 *      default (`computeDefault`).
 *
 *   2. **Per-user profile row** in
 *      `notification.notification_user_preference_profiles`. Holds the
 *      quiet-hours window, the IANA time-zone, the senior-mode flag,
 *      and the globally-unsubscribed flag.
 *
 * The full-replace upsert is wrapped in a Prisma `$transaction` so
 * `entries` writes and the profile write succeed or fail together; a
 * mid-flight crash leaves no partially-applied state.
 *
 * **Defaults policy** (PDD §12.3 + CLAUDE.md §12):
 *
 *   | category      | channel  | default opt-in        |
 *   |---------------|----------|-----------------------|
 *   | transactional | email    | true                  |
 *   | transactional | sms      | true                  |
 *   | transactional | push     | true                  |
 *   | transactional | in_app   | true                  |
 *   | system        | email    | true                  |
 *   | system        | sms      | true                  |
 *   | system        | push     | true                  |
 *   | system        | in_app   | true                  |
 *   | marketing     | email    | false (CAN-SPAM)      |
 *   | marketing     | sms      | false (TCPA)          |
 *   | marketing     | push     | false                 |
 *   | marketing     | in_app   | true                  |
 *
 * For senior-flagged users, marketing defaults are forced to `false`
 * regardless of channel.
 */
@Injectable()
export class PreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Read paths ──────────────────────────────────────────────────────

  async getForUser(userId: string): Promise<ResolvedUserPreferences> {
    const [explicitRows, profileRow] = await Promise.all([
      this.prisma.notificationPreference.findMany({
        where: { userId },
        select: { channel: true, category: true, optIn: true, updatedAt: true },
      }),
      this.prisma.notificationUserPreferenceProfile.findUnique({
        where: { userId },
        select: {
          quietHoursStartMinute: true,
          quietHoursEndMinute: true,
          timeZone: true,
          seniorMode: true,
          globallyUnsubscribed: true,
          updatedAt: true,
        },
      }),
    ]);

    const seniorMode = profileRow?.seniorMode ?? false;
    const explicitMap = new Map<string, { optIn: boolean }>();
    for (const row of explicitRows) {
      explicitMap.set(keyOf(row.channel, row.category), { optIn: row.optIn });
    }

    const entries = enumerateMatrix(seniorMode, explicitMap);
    let latestEntryUpdate: Date | null = null;
    for (const row of explicitRows) {
      if (latestEntryUpdate === null || row.updatedAt > latestEntryUpdate) {
        latestEntryUpdate = row.updatedAt;
      }
    }
    const updatedAt =
      profileRow?.updatedAt && latestEntryUpdate
        ? profileRow.updatedAt > latestEntryUpdate
          ? profileRow.updatedAt
          : latestEntryUpdate
        : (profileRow?.updatedAt ?? latestEntryUpdate);

    return {
      userId,
      entries,
      quietHours: extractQuietHours(profileRow),
      seniorMode,
      globallyUnsubscribed: profileRow?.globallyUnsubscribed ?? false,
      updatedAt: updatedAt ?? null,
    };
  }

  async getEffectivePreference(
    userId: string,
    channel: NotificationChannelKind,
    category: NotificationCategory,
  ): Promise<EffectivePreference> {
    const [row, profile] = await Promise.all([
      this.prisma.notificationPreference.findUnique({
        where: { userId_channel_category: { userId, channel, category } },
        select: { optIn: true },
      }),
      this.prisma.notificationUserPreferenceProfile.findUnique({
        where: { userId },
        select: { seniorMode: true, globallyUnsubscribed: true },
      }),
    ]);

    if (row) {
      return {
        optIn: row.optIn,
        explicit: true,
        globallyUnsubscribed: profile?.globallyUnsubscribed ?? false,
        seniorMode: profile?.seniorMode ?? false,
      };
    }
    return {
      optIn: computeDefault(channel, category, profile?.seniorMode ?? false),
      explicit: false,
      globallyUnsubscribed: profile?.globallyUnsubscribed ?? false,
      seniorMode: profile?.seniorMode ?? false,
    };
  }

  // ─── Write path ──────────────────────────────────────────────────────

  async upsertForUser(
    userId: string,
    request: UpsertPreferencesRequest,
  ): Promise<ResolvedUserPreferences> {
    rejectDuplicateEntries(request.entries);

    await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
      // Full-replace semantics: delete every existing row for the user,
      // then re-insert the requested entries. The composite PK on
      // `(user_id, channel, category)` keeps the re-insert idempotent
      // within the transaction.
      await tx.notificationPreference.deleteMany({ where: { userId } });
      if (request.entries.length > 0) {
        await tx.notificationPreference.createMany({
          data: request.entries.map((entry: PreferenceEntry) => ({
            userId,
            channel: entry.channel,
            category: entry.category,
            optIn: entry.optIn,
          })),
        });
      }

      // Quiet-hours upsert. `quietHours` is optional (no change to the
      // window); explicit-null clears the window. The other profile
      // fields (seniorMode, globallyUnsubscribed) are not touched by
      // self-service preferences — admin tooling sets them.
      if (request.quietHours !== undefined) {
        const data =
          request.quietHours === null
            ? {
                quietHoursStartMinute: null,
                quietHoursEndMinute: null,
                timeZone: null,
              }
            : {
                quietHoursStartMinute: request.quietHours.startMinuteOfDay,
                quietHoursEndMinute: request.quietHours.endMinuteOfDay,
                timeZone: request.quietHours.timeZone,
              };
        await tx.notificationUserPreferenceProfile.upsert({
          where: { userId },
          create: { userId, ...data },
          update: data,
        });
      }
    });

    return this.getForUser(userId);
  }

  // ─── Admin-set primitives (used by upstream lifecycle events) ────────

  async setSeniorMode(userId: string, seniorMode: boolean): Promise<void> {
    await this.prisma.notificationUserPreferenceProfile.upsert({
      where: { userId },
      create: { userId, seniorMode },
      update: { seniorMode },
    });
  }

  async setGloballyUnsubscribed(userId: string, unsubscribed: boolean): Promise<void> {
    await this.prisma.notificationUserPreferenceProfile.upsert({
      where: { userId },
      create: { userId, globallyUnsubscribed: unsubscribed },
      update: { globallyUnsubscribed: unsubscribed },
    });
  }
}

// ─── Pure helpers (exported for cross-module use + testing) ────────────

export const CHANNELS: readonly NotificationChannelKind[] = [
  'email',
  'sms',
  'push',
  'in_app',
] as const;

export const CATEGORIES: readonly NotificationCategory[] = [
  'transactional',
  'marketing',
  'system',
] as const;

/**
 * Default opt-in for a `(channel, category)` pair given the user's
 * senior-mode flag. The dispatch orchestrator never sees this — the
 * defaults are materialised via `getEffectivePreference` and the
 * full-matrix view via `getForUser`.
 */
export function computeDefault(
  channel: NotificationChannelKind,
  category: NotificationCategory,
  seniorMode: boolean,
): boolean {
  if (category === 'marketing') {
    // CAN-SPAM / TCPA: marketing requires explicit opt-in for the
    // off-platform channels. In-app is the exception — a banner on the
    // family-portal dashboard is fair game without prior consent.
    if (seniorMode) return false;
    if (channel === 'in_app') return true;
    return false;
  }
  // transactional + system default to opt-in across every channel.
  return true;
}

export interface EffectivePreference {
  readonly optIn: boolean;
  readonly explicit: boolean;
  readonly globallyUnsubscribed: boolean;
  readonly seniorMode: boolean;
}

export interface ResolvedUserPreferences {
  readonly userId: string;
  readonly entries: ResolvedPreferenceEntry[];
  readonly quietHours: QuietHoursWindow | null;
  readonly seniorMode: boolean;
  readonly globallyUnsubscribed: boolean;
  readonly updatedAt: Date | null;
}

function keyOf(channel: NotificationChannelKind, category: NotificationCategory): string {
  return `${channel}::${category}`;
}

function enumerateMatrix(
  seniorMode: boolean,
  explicitMap: Map<string, { optIn: boolean }>,
): ResolvedPreferenceEntry[] {
  const out: ResolvedPreferenceEntry[] = [];
  for (const channel of CHANNELS) {
    for (const category of CATEGORIES) {
      const explicit = explicitMap.get(keyOf(channel, category));
      out.push({
        channel,
        category,
        optIn: explicit ? explicit.optIn : computeDefault(channel, category, seniorMode),
        explicit: Boolean(explicit),
      });
    }
  }
  return out;
}

function extractQuietHours(
  profile: {
    quietHoursStartMinute: number | null;
    quietHoursEndMinute: number | null;
    timeZone: string | null;
  } | null,
): QuietHoursWindow | null {
  if (!profile) return null;
  if (
    profile.quietHoursStartMinute === null ||
    profile.quietHoursEndMinute === null ||
    profile.timeZone === null
  ) {
    return null;
  }
  return {
    startMinuteOfDay: profile.quietHoursStartMinute,
    endMinuteOfDay: profile.quietHoursEndMinute,
    timeZone: profile.timeZone,
  };
}

function rejectDuplicateEntries(entries: PreferenceEntry[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    const k = keyOf(entry.channel, entry.category);
    if (seen.has(k)) {
      throw new DuplicatePreferenceEntryError(entry.channel, entry.category);
    }
    seen.add(k);
  }
}

export class DuplicatePreferenceEntryError extends Error {
  constructor(
    public readonly channel: NotificationChannelKind,
    public readonly category: NotificationCategory,
  ) {
    super(`Duplicate preference entry for (${channel}, ${category})`);
    this.name = 'DuplicatePreferenceEntryError';
  }
}
