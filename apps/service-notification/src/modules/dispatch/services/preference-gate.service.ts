import { Injectable } from '@nestjs/common';
import type {
  NotificationCategory,
  NotificationChannelKind,
  QuietHoursWindow,
} from '@taste-and-see/contracts';

import { PreferencesService } from '../../preferences/services/preferences.service';
import { PrismaService } from '../../../prisma/prisma.service';

import { QuietHoursService } from './quiet-hours.service';

/**
 * Preference + quiet-hours composite gate (TS-073).
 *
 * Pre-flight check the dispatch orchestrator runs before invoking a
 * channel adapter. Decisions are exhaustive — the result is either a
 * concrete allow or a typed suppress with a reason.
 *
 * Order of evaluation (first match wins):
 *
 *   1. **Globally unsubscribed.** A user with `globally_unsubscribed =
 *      true` on the profile row can never receive any kind of message.
 *      This is the CAN-SPAM master kill-switch. Sends a
 *      `suppressed_by_unsubscribed` row.
 *
 *   2. **Preference opted-out.** The effective preference for the
 *      `(channel, category)` pair is false (either explicit or default).
 *      Sends `suppressed_by_preference`.
 *
 *   3. **In quiet hours, no bypass.** The current time falls inside
 *      the user's quiet-hours window AND
 *        - the caller did NOT request `bypassQuietHours`, OR
 *        - the caller requested bypass but the category is NOT
 *          `transactional` (marketing + system can't bypass).
 *      Sends `suppressed_by_quiet_hours`.
 *
 *   4. **Allow.** All three checks passed.
 */
@Injectable()
export class PreferenceGateService {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly quietHours: QuietHoursService,
    private readonly prisma: PrismaService,
  ) {}

  async decide(input: PreferenceGateInput, now: Date): Promise<PreferenceGateDecision> {
    const effective = await this.preferences.getEffectivePreference(
      input.recipientUserId,
      input.channel,
      input.category,
    );

    if (effective.globallyUnsubscribed) {
      return { allow: false, suppressionReason: 'globally_unsubscribed' };
    }

    if (!effective.optIn) {
      return { allow: false, suppressionReason: 'preference_opted_out' };
    }

    // Quiet-hours bypass only honored for transactional category.
    const canBypass = input.bypassQuietHours && input.category === 'transactional';
    if (!canBypass) {
      const window = await this.loadQuietHoursWindow(input.recipientUserId);
      const decision = this.quietHours.isInQuietHours(now, window);
      if (decision.inWindow) {
        return { allow: false, suppressionReason: 'quiet_hours' };
      }
    }

    return { allow: true };
  }

  /**
   * Load the user's quiet-hours window from the profile row. Returns
   * null when no row exists or the window is unset.
   */
  private async loadQuietHoursWindow(userId: string): Promise<QuietHoursWindow | null> {
    const profile = await this.prisma.notificationUserPreferenceProfile.findUnique({
      where: { userId },
      select: {
        quietHoursStartMinute: true,
        quietHoursEndMinute: true,
        timeZone: true,
      },
    });
    if (
      !profile ||
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
}

export interface PreferenceGateInput {
  readonly recipientUserId: string;
  readonly channel: NotificationChannelKind;
  readonly category: NotificationCategory;
  readonly bypassQuietHours: boolean;
}

export type PreferenceGateDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly suppressionReason: 'globally_unsubscribed' | 'preference_opted_out' | 'quiet_hours';
    };
