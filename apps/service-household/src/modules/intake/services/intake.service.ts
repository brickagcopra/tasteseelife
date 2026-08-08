import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  DementiaStatus,
  SeniorIntake,
  SeniorIntakeResponse,
  SeniorMobilityLevel,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { IntakePayloadCipherService } from './intake-payload-cipher.service';

/**
 * Domain service for the senior intake form (TS-031).
 *
 * Two surfaces:
 *
 *   - `upsert({ seniorId, requester, intake })` — encrypt the sensitive
 *     fields, write the row, set `intake_completed_at` on the first
 *     non-empty intake, return the read-back response DTO.
 *
 *   - `get({ seniorId, requester })` — read the row, decrypt the
 *     sensitive blob, return the response DTO.
 *
 * Authorisation. The intake belongs to a senior, which belongs to a
 * household. A request can only operate on a senior whose household
 * the requester has an *active* membership in (i.e. `removed_at IS
 * NULL`). The check fires inside this service today — TS-141's
 * Prisma extension will move enforcement down a layer so the
 * controller cannot bypass it by forgetting to call us.
 *
 * Atomicity. The encrypt-and-write path runs inside a Postgres
 * transaction; the membership lookup, the senior lookup, and the
 * row update all share a snapshot so a concurrent role revocation
 * cannot land between the auth check and the write.
 *
 * Empty-intake semantics. An empty plaintext payload (no DOB, no
 * notes, only defaults on the operational fields) writes `NULL` to
 * the four encrypted columns and does NOT advance
 * `intake_completed_at`. This lets the family-dashboard surface a
 * "still needed" nudge unambiguously.
 */
@Injectable()
export class IntakeService {
  private readonly logger = new Logger(IntakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: IntakePayloadCipherService,
  ) {}

  async upsert(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
    readonly intake: SeniorIntake;
  }): Promise<SeniorIntakeResponse> {
    const { seniorId, requesterUserId, intake } = args;

    const { senior } = await this.loadAuthorisedSenior(seniorId, requesterUserId);

    const sensitive = extractSensitive(intake);
    const hasSensitive = !isEmptySensitive(sensitive);
    const encrypted = hasSensitive ? this.cipher.encrypt(JSON.stringify(sensitive)) : null;

    const now = new Date();
    const shouldStampCompletion =
      senior.intakeCompletedAt === null && (hasSensitive || hasOperational(intake));

    const updated = await this.prisma.senior.update({
      where: { id: seniorId },
      data: {
        languageTags: intake.languageTags,
        dietaryTags: intake.dietaryTags,
        allergenTags: intake.allergenTags,
        mobilityLevel: intake.mobilityLevel,
        dementiaStatus: intake.dementiaStatus,
        intakePayloadCiphertext: encrypted === null ? null : encrypted.ciphertext,
        intakePayloadIv: encrypted === null ? null : encrypted.iv,
        intakePayloadAuthTag: encrypted === null ? null : encrypted.authTag,
        intakePayloadKeyVersion: encrypted === null ? null : encrypted.keyVersion,
        // Absent (not `undefined`-valued) when we are not stamping, so the
        // column keeps whatever completion timestamp it already has
        // (TS-501 — `exactOptionalPropertyTypes` rejects the explicit
        // `undefined`).
        ...(shouldStampCompletion && { intakeCompletedAt: now }),
      },
      select: INTAKE_SELECT,
    });

    this.logger.log(
      { seniorId, requesterUserId, hasSensitive, completedStamp: shouldStampCompletion },
      'senior intake upserted',
    );

    return this.toResponse(updated);
  }

  async get(args: {
    readonly seniorId: string;
    readonly requesterUserId: string;
  }): Promise<SeniorIntakeResponse> {
    const { senior, memberRole } = await this.loadAuthorisedSenior(
      args.seniorId,
      args.requesterUserId,
    );

    // TS-238 — family-observability consent gate on the `health` surface.
    // The intake is the senior's health/medical profile (DOB, dementia
    // stage, encrypted medical notes). A `family_observer` may only read
    // it when the senior has consented to share health (CLAUDE.md §12 —
    // "family observers see what the senior has consented to share"; the
    // default is opt-out). The primary payer (account manager) and the
    // senior end-user are NOT observers — they read unconditionally.
    // Write access (the PUT upsert) is intentionally not gated here:
    // TS-238 tunes *visibility*, not write permission (carved as a
    // follow-up). A senior with no consent row is opted out by default,
    // so the absent-row case (`health` undefined) blocks the observer.
    if (memberRole === 'family_observer') {
      const consent = await this.prisma.seniorConsent.findUnique({
        where: { seniorId: args.seniorId },
        select: { health: true },
      });
      if (consent?.health !== true) {
        throw new ForbiddenException({
          type: 'about:blank',
          title: 'Forbidden',
          status: 403,
          detail:
            'The senior has not consented to share their health information with family observers.',
        });
      }
    }

    return this.toResponse(senior);
  }

  /**
   * Membership-checked senior lookup. Returns the senior row (with the
   * intake-relevant columns) **and the requester's membership role** when
   * the requester is an active member of the household; throws 404 on
   * missing senior, 403 on no active membership. The role drives the
   * TS-238 family-observability gate in `get()`.
   *
   * Two queries today rather than one because the cross-table membership
   * read is logically a different access decision than the senior
   * lookup — keeping them separate makes the authorisation pivot
   * obvious in code reviews. A single LEFT JOIN would be marginally
   * faster but conflates the two concerns.
   */
  private async loadAuthorisedSenior(
    seniorId: string,
    requesterUserId: string,
  ): Promise<{ readonly senior: SeniorRow; readonly memberRole: string }> {
    const senior = await this.prisma.senior.findFirst({
      where: { id: seniorId, deletedAt: null },
      select: INTAKE_SELECT,
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
      // Generic 403 — the requester is authenticated but does not
      // belong to the household. We deliberately do NOT return 404
      // here even though the household-side semantics would let us:
      // returning 404 would let an attacker confirm a senior id does
      // not exist (probe with random ids until one returns 403 instead
      // of 404). Forbidden is the correct shape for "the resource
      // exists, you cannot access it" and is the conservative default
      // until a senior id is treated as PII (it isn't today — it's
      // a CUID, not an enumerable integer).
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this senior.',
      });
    }

    return { senior, memberRole: membership.memberRole };
  }

  private toResponse(row: SeniorRow): SeniorIntakeResponse {
    const decrypted = this.decryptOrEmpty(row);
    return {
      seniorId: row.id,
      languageTags: row.languageTags,
      dietaryTags: row.dietaryTags,
      allergenTags: row.allergenTags,
      mobilityLevel: row.mobilityLevel as SeniorMobilityLevel,
      dementiaStatus: row.dementiaStatus as DementiaStatus,
      dateOfBirth: decrypted.dateOfBirth,
      dietaryNotes: decrypted.dietaryNotes,
      allergyNotes: decrypted.allergyNotes,
      mobilityNotes: decrypted.mobilityNotes,
      medicalNotes: decrypted.medicalNotes,
      intakeCompletedAt:
        row.intakeCompletedAt === null ? null : row.intakeCompletedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Decrypt the sensitive payload, or return an empty shape if the
   * intake has never been completed. Falls back to an empty shape on a
   * malformed JSON parse — we already authenticated the GCM tag, so
   * malformed JSON would mean an internal corruption rather than an
   * attacker, but we still avoid throwing into the response path so a
   * single corrupt row doesn't prevent the family dashboard from
   * rendering the rest of the household.
   */
  private decryptOrEmpty(row: SeniorRow): {
    readonly dateOfBirth: string | null;
    readonly dietaryNotes: string | null;
    readonly allergyNotes: string | null;
    readonly mobilityNotes: string | null;
    readonly medicalNotes: string | null;
  } {
    const ciphertext = row.intakePayloadCiphertext;
    const iv = row.intakePayloadIv;
    const authTag = row.intakePayloadAuthTag;
    const keyVersion = row.intakePayloadKeyVersion;
    if (ciphertext === null || iv === null || authTag === null || keyVersion === null) {
      return EMPTY_SENSITIVE;
    }
    const plaintext = this.cipher.decrypt({ ciphertext, iv, authTag, keyVersion });
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (err) {
      this.logger.error(
        { seniorId: row.id, err: err instanceof Error ? err.message : String(err) },
        'intake payload JSON parse failed after successful GCM auth — possible internal corruption',
      );
      return EMPTY_SENSITIVE;
    }
    return normaliseSensitive(parsed);
  }
}

/**
 * Operational columns the chef-match query reads, plus the encrypted
 * payload columns the intake response carries. Centralised so the
 * `findFirst` / `update` select clauses agree.
 */
const INTAKE_SELECT = {
  id: true,
  householdId: true,
  languageTags: true,
  dietaryTags: true,
  allergenTags: true,
  mobilityLevel: true,
  dementiaStatus: true,
  intakePayloadCiphertext: true,
  intakePayloadIv: true,
  intakePayloadAuthTag: true,
  intakePayloadKeyVersion: true,
  intakeCompletedAt: true,
  updatedAt: true,
} as const;

interface SeniorRow {
  readonly id: string;
  readonly householdId: string;
  readonly languageTags: string[];
  readonly dietaryTags: string[];
  readonly allergenTags: string[];
  readonly mobilityLevel: string;
  readonly dementiaStatus: string;
  readonly intakePayloadCiphertext: Buffer | null;
  readonly intakePayloadIv: Buffer | null;
  readonly intakePayloadAuthTag: Buffer | null;
  readonly intakePayloadKeyVersion: number | null;
  readonly intakeCompletedAt: Date | null;
  readonly updatedAt: Date;
}

interface SensitivePayload {
  readonly dateOfBirth: string | null;
  readonly dietaryNotes: string | null;
  readonly allergyNotes: string | null;
  readonly mobilityNotes: string | null;
  readonly medicalNotes: string | null;
}

const EMPTY_SENSITIVE: SensitivePayload = {
  dateOfBirth: null,
  dietaryNotes: null,
  allergyNotes: null,
  mobilityNotes: null,
  medicalNotes: null,
};

/**
 * Project the SeniorIntake DTO down to the five sensitive fields that
 * land in the encrypted payload. We deliberately do not include the
 * dementia status in the encrypted blob — it's an operational column.
 */
function extractSensitive(intake: SeniorIntake): {
  readonly dateOfBirth: string | null;
  readonly dietaryNotes: string | null;
  readonly allergyNotes: string | null;
  readonly mobilityNotes: string | null;
  readonly medicalNotes: string | null;
} {
  return {
    dateOfBirth: intake.dateOfBirth ?? null,
    dietaryNotes: intake.dietaryNotes ?? null,
    allergyNotes: intake.allergyNotes ?? null,
    mobilityNotes: intake.mobilityNotes ?? null,
    medicalNotes: intake.medicalNotes ?? null,
  };
}

function isEmptySensitive(sensitive: ReturnType<typeof extractSensitive>): boolean {
  return (
    sensitive.dateOfBirth === null &&
    sensitive.dietaryNotes === null &&
    sensitive.allergyNotes === null &&
    sensitive.mobilityNotes === null &&
    sensitive.medicalNotes === null
  );
}

/**
 * "Has the family ever filled in *anything* meaningful?" Used to decide
 * whether to stamp `intake_completed_at` on the first write. A purely
 * operational intake (just tags / mobility level) is enough — we don't
 * want the dashboard nudge to ask families "please add a DOB" if they
 * have intentionally chosen not to share one.
 */
function hasOperational(intake: SeniorIntake): boolean {
  return (
    intake.languageTags.length > 0 ||
    intake.dietaryTags.length > 0 ||
    intake.allergenTags.length > 0 ||
    intake.mobilityLevel !== 'unknown' ||
    intake.dementiaStatus !== 'none'
  );
}

/**
 * Coerce a freshly-decrypted JSON object into the response shape.
 * Defensive against legacy rows whose JSON predates a field rename
 * — every field defaults to null when missing.
 */
function normaliseSensitive(parsed: unknown): SensitivePayload {
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_SENSITIVE;
  const p = parsed as Record<string, unknown>;
  return {
    dateOfBirth: typeof p['dateOfBirth'] === 'string' ? p['dateOfBirth'] : null,
    dietaryNotes: typeof p['dietaryNotes'] === 'string' ? p['dietaryNotes'] : null,
    allergyNotes: typeof p['allergyNotes'] === 'string' ? p['allergyNotes'] : null,
    mobilityNotes: typeof p['mobilityNotes'] === 'string' ? p['mobilityNotes'] : null,
    medicalNotes: typeof p['medicalNotes'] === 'string' ? p['medicalNotes'] : null,
  };
}
