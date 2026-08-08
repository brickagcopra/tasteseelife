import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  SENIOR_ALERT_PREFERENCES_DEFAULTS,
  type SeniorAlertPreferencesFlags,
  type SeniorAlertPreferencesResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the per-(senior × family-member) alert subscription
 * map (TS-234; PRD §6.4 "Alert configurations"; PDD §12.3).
 *
 * Two surfaces:
 *
 *   - `getMyPreferences({ seniorId, requesterUserId })`
 *       Read the caller's *own* three alert-type flags for the senior.
 *       The absence of a row is the synthesised default (operational +
 *       safety alerts on, observation-derived alert off — see
 *       `SENIOR_ALERT_PREFERENCES_DEFAULTS`).
 *
 *   - `setMyPreferences({ seniorId, requesterUserId, flags })`
 *       Full-replace of the caller's own three flags. Upserts the
 *       `(seniorId, requesterUserId)` row.
 *
 * Authorisation differs from `SeniorConsentService`. Consent is set by
 * the account manager on the senior's behalf, so it gates on a
 * manager-role capability. An alert subscription is a member subscribing
 * *themselves*, so there is **no manager gate** — every active household
 * member may read and write their own row. Both methods run
 * `assertSeniorMembership` first: 404 on a missing / soft-deleted senior,
 * 403 when the caller is not an active member of the senior's household.
 * The composite-key write means a member can never touch another member's
 * subscription — `userId` is the authenticated caller, never client input.
 *
 * No PII in logs. We log `seniorId`, `requesterUserId`, and the count of
 * subscribed alert types — never anything from the senior's profile.
 */
@Injectable()
export class SeniorAlertPreferencesService {
  private readonly logger = new Logger(SeniorAlertPreferencesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getMyPreferences(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
  }): Promise<SeniorAlertPreferencesResponse> {
    await this.assertSeniorMembership(args.seniorId, args.requesterUserId);
    const row = await this.prisma.seniorAlertPreference.findUnique({
      where: { seniorId_userId: { seniorId: args.seniorId, userId: args.requesterUserId } },
      select: PREFERENCES_SELECT,
    });
    return toResponse(args.seniorId, row);
  }

  async setMyPreferences(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
    readonly flags: SeniorAlertPreferencesFlags;
  }): Promise<SeniorAlertPreferencesResponse> {
    const { seniorId, requesterUserId, flags } = args;
    await this.assertSeniorMembership(seniorId, requesterUserId);

    const row = await this.prisma.seniorAlertPreference.upsert({
      where: { seniorId_userId: { seniorId, userId: requesterUserId } },
      create: {
        seniorId,
        userId: requesterUserId,
        missedVisit: flags.missedVisit,
        concerningObservation: flags.concerningObservation,
        emergencyFlag: flags.emergencyFlag,
      },
      update: {
        missedVisit: flags.missedVisit,
        concerningObservation: flags.concerningObservation,
        emergencyFlag: flags.emergencyFlag,
      },
      select: PREFERENCES_SELECT,
    });

    this.logger.log(
      {
        seniorId,
        requesterUserId,
        subscribedAlertCount:
          Number(flags.missedVisit) +
          Number(flags.concerningObservation) +
          Number(flags.emergencyFlag),
      },
      'senior alert preferences updated',
    );

    return toResponse(seniorId, row);
  }

  /**
   * Membership-checked senior lookup. Two queries (senior, then
   * membership) rather than a JOIN — the cross-table membership read is a
   * different access decision than the senior lookup, and keeping them
   * separate makes the authorisation pivot obvious in review. Mirrors
   * `SeniorConsentService.loadAuthorisedSeniorMembership`, but does not
   * return the role: alert subscriptions have no manager gate, so the
   * caller's role is irrelevant once membership is confirmed.
   *
   * 404 on a missing / soft-deleted senior; 403 when the caller holds no
   * active membership (deliberately Forbidden, not Not Found — a senior
   * id is a CUID, not an enumerable integer, so we do not leak existence
   * via the status code).
   */
  private async assertSeniorMembership(seniorId: string, requesterUserId: string): Promise<void> {
    const senior = await this.prisma.senior.findFirst({
      where: { id: seniorId, deletedAt: null },
      select: { id: true, householdId: true },
    });
    if (senior === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Senior not found.',
      });
    }
    const membership = await this.prisma.householdMember.findFirst({
      where: {
        householdId: senior.householdId,
        userId: requesterUserId,
        removedAt: null,
      },
      select: { id: true },
    });
    if (membership === null) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this senior.',
      });
    }
  }
}

const PREFERENCES_SELECT = {
  missedVisit: true,
  concerningObservation: true,
  emergencyFlag: true,
  updatedAt: true,
} as const;

interface PreferencesRow {
  readonly missedVisit: boolean;
  readonly concerningObservation: boolean;
  readonly emergencyFlag: boolean;
  readonly updatedAt: Date;
}

/**
 * Map a preferences row (or its absence) into the response DTO. A missing
 * row is the synthesised default (`SENIOR_ALERT_PREFERENCES_DEFAULTS`)
 * with a null `updatedAt` — observationally identical to an explicit row
 * carrying those defaults, which is the point: a member who never touched
 * their settings gets the operational-on / observation-off baseline.
 */
function toResponse(seniorId: string, row: PreferencesRow | null): SeniorAlertPreferencesResponse {
  if (row === null) {
    return {
      seniorId,
      missedVisit: SENIOR_ALERT_PREFERENCES_DEFAULTS.missedVisit,
      concerningObservation: SENIOR_ALERT_PREFERENCES_DEFAULTS.concerningObservation,
      emergencyFlag: SENIOR_ALERT_PREFERENCES_DEFAULTS.emergencyFlag,
      updatedAt: null,
    };
  }
  return {
    seniorId,
    missedVisit: row.missedVisit,
    concerningObservation: row.concerningObservation,
    emergencyFlag: row.emergencyFlag,
    updatedAt: row.updatedAt.toISOString(),
  };
}
