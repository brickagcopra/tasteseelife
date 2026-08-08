import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  HouseholdAccessInstructions,
  HouseholdAccessInstructionsResponse,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';
import { AccessInstructionsCipherService } from './access-instructions-cipher.service';

/**
 * Domain service for the household access-instructions form (TS-032).
 *
 * Two surfaces, mirroring the senior-intake shape:
 *
 *   - `upsert({ householdId, requesterUserId, payload })` — encrypt
 *     the non-empty fields into a single JSON blob, write the four
 *     ciphertext columns + the `access_instructions_updated_at`
 *     timestamp, return the read-back response DTO.
 *
 *   - `get({ householdId, requesterUserId })` — read the row, decrypt
 *     the blob, return the response DTO. Returns an "empty" payload
 *     (every field null) when the form has never been completed.
 *
 * Authorisation. The instructions belong to a household. A request
 * can only operate on a household the requester has an *active*
 * membership in (i.e. `removed_at IS NULL`). The check fires inside
 * this service today; TS-141's Prisma extension will move enforcement
 * down so the controller cannot bypass it.
 *
 * Empty-payload semantics. A request whose JSON has every field null
 * writes NULL to the four ciphertext columns AND clears
 * `access_instructions_updated_at` — the family-dashboard surfaces a
 * "you haven't entered access instructions yet" nudge unambiguously.
 *
 * Why an empty payload clears `access_instructions_updated_at` here
 * (vs senior intake's "once stamped, never cleared" rule)? The intake
 * form has operational tag columns that carry meaning even when the
 * sensitive blob is empty; the access form has nothing but the blob.
 * A cleared blob is a deliberate "I no longer want this on file"
 * action — the timestamp goes with it.
 */
@Injectable()
export class HouseholdAccessService {
  private readonly logger = new Logger(HouseholdAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: AccessInstructionsCipherService,
  ) {}

  async upsert(args: {
    readonly householdId: string;
    readonly requesterUserId: string;
    readonly payload: HouseholdAccessInstructions;
  }): Promise<HouseholdAccessInstructionsResponse> {
    const { householdId, requesterUserId, payload } = args;

    await this.assertActiveMembership(householdId, requesterUserId);
    const normalised = normalisePayload(payload);
    const isEmpty = isEmptyPayload(normalised);

    const encrypted = isEmpty ? null : this.cipher.encrypt(JSON.stringify(normalised));
    const now = new Date();

    const updated = await this.prisma.household.update({
      where: { id: householdId },
      data: {
        accessInstructionsCiphertext: encrypted === null ? null : encrypted.ciphertext,
        accessInstructionsIv: encrypted === null ? null : encrypted.iv,
        accessInstructionsAuthTag: encrypted === null ? null : encrypted.authTag,
        accessInstructionsKeyVersion: encrypted === null ? null : encrypted.keyVersion,
        accessInstructionsUpdatedAt: isEmpty ? null : now,
      },
      select: ACCESS_SELECT,
    });

    this.logger.log(
      { householdId, requesterUserId, cleared: isEmpty },
      'household access instructions upserted',
    );

    return this.toResponse(updated);
  }

  async get(args: {
    readonly householdId: string;
    readonly requesterUserId: string;
  }): Promise<HouseholdAccessInstructionsResponse> {
    await this.assertActiveMembership(args.householdId, args.requesterUserId);
    const row = await this.prisma.household.findFirst({
      where: { id: args.householdId, deletedAt: null },
      select: ACCESS_SELECT,
    });
    if (row === null) {
      // The household disappeared between the membership check and the
      // read. Surface as 404 — the requester was authorised, but the
      // resource is gone.
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Household not found.',
      });
    }
    return this.toResponse(row);
  }

  /**
   * Active-membership precondition. Two queries today rather than one
   * — the household lookup (404 on missing) is logically separate from
   * the membership lookup (403 on no active row). A single LEFT JOIN
   * would be marginally faster but would conflate the two access
   * decisions in a way that hurts code review.
   *
   * Returns void on success; throws 404 / 403 on failure.
   */
  private async assertActiveMembership(
    householdId: string,
    requesterUserId: string,
  ): Promise<void> {
    const household = await this.prisma.household.findFirst({
      where: { id: householdId, deletedAt: null },
      select: { id: true },
    });
    if (household === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Household not found.',
      });
    }
    const membership = await this.prisma.householdMember.findFirst({
      where: { householdId, userId: requesterUserId, removedAt: null },
      select: { id: true },
    });
    if (membership === null) {
      // Generic 403 — see IntakeService.loadAuthorisedSenior for the
      // matching rationale (we deliberately do not return 404 when the
      // resource exists but the caller is not a member).
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this household.',
      });
    }
  }

  private toResponse(row: HouseholdAccessRow): HouseholdAccessInstructionsResponse {
    const decrypted = this.decryptOrEmpty(row);
    return {
      householdId: row.id,
      doorCode: decrypted.doorCode,
      keyLocation: decrypted.keyLocation,
      alarmCode: decrypted.alarmCode,
      alarmDisarmInstructions: decrypted.alarmDisarmInstructions,
      parkingInstructions: decrypted.parkingInstructions,
      doormanInfo: decrypted.doormanInfo,
      petInfo: decrypted.petInfo,
      generalNotes: decrypted.generalNotes,
      accessInstructionsUpdatedAt:
        row.accessInstructionsUpdatedAt === null
          ? null
          : row.accessInstructionsUpdatedAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * Decrypt the payload, or return the empty shape if the row has
   * never carried instructions. Falls back to the empty shape on a
   * malformed-JSON-after-successful-GCM-auth case — that's an internal
   * corruption (not an attacker), but we still avoid throwing into the
   * response path so a single corrupt row doesn't prevent the family
   * dashboard from rendering the rest of the household.
   */
  private decryptOrEmpty(row: HouseholdAccessRow): NormalisedAccessPayload {
    const ciphertext = row.accessInstructionsCiphertext;
    const iv = row.accessInstructionsIv;
    const authTag = row.accessInstructionsAuthTag;
    const keyVersion = row.accessInstructionsKeyVersion;
    if (ciphertext === null || iv === null || authTag === null || keyVersion === null) {
      return EMPTY_PAYLOAD;
    }
    const plaintext = this.cipher.decrypt({ ciphertext, iv, authTag, keyVersion });
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch (err) {
      this.logger.error(
        { householdId: row.id, err: err instanceof Error ? err.message : String(err) },
        'access-instructions JSON parse failed after successful GCM auth — possible internal corruption',
      );
      return EMPTY_PAYLOAD;
    }
    return normaliseDecrypted(parsed);
  }
}

/**
 * Columns the response DTO needs. Centralised so the `findFirst` and
 * `update` select clauses agree on shape.
 */
const ACCESS_SELECT = {
  id: true,
  accessInstructionsCiphertext: true,
  accessInstructionsIv: true,
  accessInstructionsAuthTag: true,
  accessInstructionsKeyVersion: true,
  accessInstructionsUpdatedAt: true,
  updatedAt: true,
} as const;

interface HouseholdAccessRow {
  readonly id: string;
  readonly accessInstructionsCiphertext: Buffer | null;
  readonly accessInstructionsIv: Buffer | null;
  readonly accessInstructionsAuthTag: Buffer | null;
  readonly accessInstructionsKeyVersion: number | null;
  readonly accessInstructionsUpdatedAt: Date | null;
  readonly updatedAt: Date;
}

interface NormalisedAccessPayload {
  readonly doorCode: string | null;
  readonly keyLocation: string | null;
  readonly alarmCode: string | null;
  readonly alarmDisarmInstructions: string | null;
  readonly parkingInstructions: string | null;
  readonly doormanInfo: string | null;
  readonly petInfo: string | null;
  readonly generalNotes: string | null;
}

const EMPTY_PAYLOAD: NormalisedAccessPayload = {
  doorCode: null,
  keyLocation: null,
  alarmCode: null,
  alarmDisarmInstructions: null,
  parkingInstructions: null,
  doormanInfo: null,
  petInfo: null,
  generalNotes: null,
};

/**
 * Project the contract DTO down to the canonical eight fields with
 * undefined collapsed to null. The contract permits both `undefined`
 * (field absent) and `null` (field explicitly cleared); the storage
 * layer only needs the null/non-null distinction.
 */
function normalisePayload(input: HouseholdAccessInstructions): NormalisedAccessPayload {
  return {
    doorCode: input.doorCode ?? null,
    keyLocation: input.keyLocation ?? null,
    alarmCode: input.alarmCode ?? null,
    alarmDisarmInstructions: input.alarmDisarmInstructions ?? null,
    parkingInstructions: input.parkingInstructions ?? null,
    doormanInfo: input.doormanInfo ?? null,
    petInfo: input.petInfo ?? null,
    generalNotes: input.generalNotes ?? null,
  };
}

function isEmptyPayload(p: NormalisedAccessPayload): boolean {
  return (
    p.doorCode === null &&
    p.keyLocation === null &&
    p.alarmCode === null &&
    p.alarmDisarmInstructions === null &&
    p.parkingInstructions === null &&
    p.doormanInfo === null &&
    p.petInfo === null &&
    p.generalNotes === null
  );
}

/**
 * Defensive coercion of a freshly-decrypted JSON object. Every field
 * defaults to null when missing or non-string so a legacy row whose
 * schema predates a future field rename still reads cleanly.
 */
function normaliseDecrypted(parsed: unknown): NormalisedAccessPayload {
  if (typeof parsed !== 'object' || parsed === null) return EMPTY_PAYLOAD;
  const p = parsed as Record<string, unknown>;
  return {
    doorCode: typeof p['doorCode'] === 'string' ? p['doorCode'] : null,
    keyLocation: typeof p['keyLocation'] === 'string' ? p['keyLocation'] : null,
    alarmCode: typeof p['alarmCode'] === 'string' ? p['alarmCode'] : null,
    alarmDisarmInstructions:
      typeof p['alarmDisarmInstructions'] === 'string' ? p['alarmDisarmInstructions'] : null,
    parkingInstructions:
      typeof p['parkingInstructions'] === 'string' ? p['parkingInstructions'] : null,
    doormanInfo: typeof p['doormanInfo'] === 'string' ? p['doormanInfo'] : null,
    petInfo: typeof p['petInfo'] === 'string' ? p['petInfo'] : null,
    generalNotes: typeof p['generalNotes'] === 'string' ? p['generalNotes'] : null,
  };
}
