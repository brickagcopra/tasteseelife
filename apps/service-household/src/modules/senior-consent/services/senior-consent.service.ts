import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { SeniorConsentFlags, SeniorConsentResponse } from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the senior family-observability consent map
 * (TS-238; PRD §6.4, §6.5; CLAUDE.md §12).
 *
 * Two surfaces:
 *
 *   - `getConsent({ seniorId, requesterUserId })`
 *       Read the four surface-visibility flags for the senior. Any
 *       active household member may read them (so a family observer can
 *       see why a surface is masked); the absence of a row is the
 *       all-`false` opt-out default (CLAUDE.md §12). The response also
 *       carries `canManage` — the caller's capability, derived from
 *       their membership role.
 *
 *   - `setConsent({ seniorId, requesterUserId, flags })`
 *       Full-replace of the four flags. Authorised for the **primary
 *       payer** (account manager / guardian) and the **senior end-user**
 *       only; a `family_observer` gets 403. Upserts the row and stamps
 *       `updated_by_user_id` with the actor.
 *
 * Authorisation. Both methods run `loadAuthorisedSeniorMembership`
 * first — the same two-query (senior lookup, then membership lookup)
 * pattern as `IntakeService` / `SeniorPreferencesService`, extended to
 * return the caller's `memberRole` so the capability gate can branch.
 * Returns 404 on a missing / soft-deleted senior, 403 when the caller
 * is not an active member.
 *
 * Why the gate masks observers only: CLAUDE.md §12 frames the boundary
 * as "family observers see what the senior has consented to share." The
 * primary payer is the account manager — not an observer — so they
 * retain full visibility; the senior end-user sees their own data
 * unconditionally. The four flags therefore tune the observer view, and
 * only the observer view.
 *
 * No PII in logs. We log `seniorId`, `requesterUserId`, and the count of
 * surfaces shared — never anything from the senior's profile.
 */
@Injectable()
export class SeniorConsentService {
  private readonly logger = new Logger(SeniorConsentService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getConsent(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
  }): Promise<SeniorConsentResponse> {
    const { memberRole } = await this.loadAuthorisedSeniorMembership(
      args.seniorId,
      args.requesterUserId,
    );
    const row = await this.prisma.seniorConsent.findUnique({
      where: { seniorId: args.seniorId },
      select: CONSENT_SELECT,
    });
    return toResponse(args.seniorId, row, canManageConsent(memberRole));
  }

  async setConsent(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
    readonly flags: SeniorConsentFlags;
  }): Promise<SeniorConsentResponse> {
    const { seniorId, requesterUserId, flags } = args;
    const { memberRole } = await this.loadAuthorisedSeniorMembership(seniorId, requesterUserId);

    // Only the primary payer (account manager / guardian) or the senior
    // end-user may set consent. A family observer reaching this point is
    // authenticated and a household member — but consent is not theirs
    // to grant on the senior's behalf (CLAUDE.md §12 — the senior
    // consents; the payer acts as guardian). 403, not 404.
    if (!canManageConsent(memberRole)) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'Only the primary payer or the senior themselves can change sharing settings.',
      });
    }

    const row = await this.prisma.seniorConsent.upsert({
      where: { seniorId },
      create: {
        seniorId,
        photos: flags.photos,
        notes: flags.notes,
        location: flags.location,
        health: flags.health,
        updatedByUserId: requesterUserId,
      },
      update: {
        photos: flags.photos,
        notes: flags.notes,
        location: flags.location,
        health: flags.health,
        updatedByUserId: requesterUserId,
      },
      select: CONSENT_SELECT,
    });

    this.logger.log(
      {
        seniorId,
        requesterUserId,
        sharedSurfaceCount:
          Number(flags.photos) +
          Number(flags.notes) +
          Number(flags.location) +
          Number(flags.health),
      },
      'senior consent updated',
    );

    // The setter is always a manager (we just gated on it), so canManage
    // is unconditionally true on the write read-back.
    return toResponse(seniorId, row, true);
  }

  /**
   * Membership-checked senior lookup that also surfaces the caller's
   * membership role. Two queries (senior, then membership) rather than a
   * JOIN — the cross-table membership read is a different access
   * decision than the senior lookup, and keeping them separate makes the
   * authorisation pivot obvious in review. Mirrors
   * `IntakeService.loadAuthorisedSenior`, extended to return the role.
   *
   * 404 on a missing / soft-deleted senior; 403 when the caller holds no
   * active membership (deliberately Forbidden, not Not Found — a senior
   * id is a CUID, not an enumerable integer, so we do not leak existence
   * via the status code).
   */
  private async loadAuthorisedSeniorMembership(
    seniorId: string,
    requesterUserId: string,
  ): Promise<{ readonly householdId: string; readonly memberRole: string }> {
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
      select: { memberRole: true },
    });
    if (membership === null) {
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this senior.',
      });
    }
    return { householdId: senior.householdId, memberRole: membership.memberRole };
  }
}

/**
 * Who may set consent. The primary payer manages the account on the
 * senior's behalf; the senior end-user sets their own. A family observer
 * may read the flags but not change them.
 */
const MANAGER_ROLES: ReadonlySet<string> = new Set(['primary_payer', 'senior_user']);

function canManageConsent(memberRole: string): boolean {
  return MANAGER_ROLES.has(memberRole);
}

const CONSENT_SELECT = {
  photos: true,
  notes: true,
  location: true,
  health: true,
  updatedByUserId: true,
  updatedAt: true,
} as const;

interface ConsentRow {
  readonly photos: boolean;
  readonly notes: boolean;
  readonly location: boolean;
  readonly health: boolean;
  readonly updatedByUserId: string | null;
  readonly updatedAt: Date;
}

/**
 * Map a consent row (or its absence) into the response DTO. A missing
 * row is the all-`false` opt-out default with null audit metadata —
 * observationally identical to an explicit all-`false` row that was
 * later cleared, which is the point: absence means "shares nothing".
 */
function toResponse(
  seniorId: string,
  row: ConsentRow | null,
  canManage: boolean,
): SeniorConsentResponse {
  if (row === null) {
    return {
      seniorId,
      photos: false,
      notes: false,
      location: false,
      health: false,
      updatedAt: null,
      updatedByUserId: null,
      canManage,
    };
  }
  return {
    seniorId,
    photos: row.photos,
    notes: row.notes,
    location: row.location,
    health: row.health,
    updatedAt: row.updatedAt.toISOString(),
    updatedByUserId: row.updatedByUserId,
    canManage,
  };
}
