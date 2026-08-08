import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD,
  type CreateEmergencyContactRequest,
  type EmergencyContact,
  type EmergencyContactsListResponse,
  type UpdateEmergencyContactRequest,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * Domain service for the household emergency-contacts roster (TS-032).
 *
 * Four surfaces:
 *
 *   - `list({ householdId, requesterUserId })`
 *       Active contacts (deletedAt IS NULL) in priority-then-createdAt
 *       order. Wrapped in `{ contacts: [...] }` for forward-compatible
 *       pagination evolution.
 *
 *   - `create({ householdId, requesterUserId, input })`
 *       Persist a new contact. Enforces the per-household cap of
 *       `EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD` (10) — over-cap inserts
 *       throw 422 UnprocessableEntity. Returns the read-back DTO.
 *
 *   - `update({ householdId, contactId, requesterUserId, input })`
 *       Patch a subset of fields. Empty patches throw 422
 *       UnprocessableEntity — the contract layer accepts `{}` for
 *       syntactic ergonomics but the service requires real intent.
 *
 *   - `remove({ householdId, contactId, requesterUserId })`
 *       Soft-delete by setting `deletedAt`. Audit reads can pull the
 *       row back via admin tooling; default list endpoint filters it
 *       out. Idempotent — repeated deletes succeed silently.
 *
 * Authorisation. Every method runs `assertActiveMembership` first.
 * Mirrors the senior-intake and access-instructions pattern: the
 * controller cannot bypass this gate today, and TS-141's Prisma
 * extension will push enforcement down further.
 *
 * No PII in logs. We log `householdId`, `requesterUserId`, the action,
 * and the contact id (post-create / on update / on remove). Names,
 * phones, emails, notes — never logged at info level. The audit-svc
 * (TS-100) is the right home for the full before/after diff.
 */
@Injectable()
export class EmergencyContactsService {
  private readonly logger = new Logger(EmergencyContactsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(args: {
    readonly householdId: string;
    readonly requesterUserId: string;
  }): Promise<EmergencyContactsListResponse> {
    await this.assertActiveMembership(args.householdId, args.requesterUserId);
    const rows = await this.prisma.emergencyContact.findMany({
      where: { householdId: args.householdId, deletedAt: null },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      select: CONTACT_SELECT,
    });
    return { contacts: rows.map(toDto) };
  }

  async create(args: {
    readonly householdId: string;
    readonly requesterUserId: string;
    readonly input: CreateEmergencyContactRequest;
  }): Promise<EmergencyContact> {
    const { householdId, requesterUserId, input } = args;
    await this.assertActiveMembership(householdId, requesterUserId);

    // Cap-check before the insert. A small race window exists where two
    // concurrent creates could both pass this check and land an 11th row;
    // the cap-as-422 contract is best-effort. A DB-level partial unique
    // index would close it but at the cost of a noisier failure mode —
    // captured as a TS-032-followup if we observe drift.
    const activeCount = await this.prisma.emergencyContact.count({
      where: { householdId, deletedAt: null },
    });
    if (activeCount >= EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD) {
      throw new UnprocessableEntityException({
        type: 'about:blank',
        title: 'Unprocessable Entity',
        status: 422,
        detail: `Cannot add another contact — household is at the ${EMERGENCY_CONTACTS_MAX_PER_HOUSEHOLD}-contact maximum.`,
      });
    }

    const created = await this.prisma.emergencyContact.create({
      data: {
        householdId,
        name: input.name,
        relationship: input.relationship,
        phone: input.phone,
        email: input.email ?? null,
        priority: input.priority,
        notes: input.notes ?? null,
      },
      select: CONTACT_SELECT,
    });

    this.logger.log(
      {
        householdId,
        requesterUserId,
        contactId: created.id,
        action: 'create',
      },
      'emergency contact created',
    );

    return toDto(created);
  }

  async update(args: {
    readonly householdId: string;
    readonly contactId: string;
    readonly requesterUserId: string;
    readonly input: UpdateEmergencyContactRequest;
  }): Promise<EmergencyContact> {
    const { householdId, contactId, requesterUserId, input } = args;
    await this.assertActiveMembership(householdId, requesterUserId);

    if (Object.keys(input).length === 0) {
      // The Zod contract accepts `{}` (no schema-level way to require
      // "at least one field") — the service rejects it so a no-op
      // request never silently succeeds.
      throw new BadRequestException({
        type: 'about:blank',
        title: 'Bad Request',
        status: 400,
        detail: 'Update request must include at least one field.',
      });
    }

    const existing = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, householdId, deletedAt: null },
      select: { id: true },
    });
    if (existing === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Emergency contact not found.',
      });
    }

    const updated = await this.prisma.emergencyContact.update({
      where: { id: contactId },
      // Conditional spreads rather than `key: value` with a possibly-
      // `undefined` value: this is a PATCH, so an omitted field must mean
      // "leave the column unchanged" — which Prisma expresses as the key
      // being ABSENT. Under `exactOptionalPropertyTypes` a present-but-
      // `undefined` property is not assignable to the generated update
      // input, and writing `null` instead would wrongly clear the column
      // (TS-501). An explicit `null` from the caller still clears, because
      // only `undefined` is filtered here.
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.relationship !== undefined && { relationship: input.relationship }),
        ...(input.phone !== undefined && { phone: input.phone }),
        ...(input.email !== undefined && { email: input.email }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.notes !== undefined && { notes: input.notes }),
      },
      select: CONTACT_SELECT,
    });

    this.logger.log(
      {
        householdId,
        requesterUserId,
        contactId: updated.id,
        action: 'update',
        fields: Object.keys(input),
      },
      'emergency contact updated',
    );

    return toDto(updated);
  }

  async remove(args: {
    readonly householdId: string;
    readonly contactId: string;
    readonly requesterUserId: string;
  }): Promise<void> {
    const { householdId, contactId, requesterUserId } = args;
    await this.assertActiveMembership(householdId, requesterUserId);

    const existing = await this.prisma.emergencyContact.findFirst({
      where: { id: contactId, householdId },
      select: { id: true, deletedAt: true },
    });
    if (existing === null) {
      throw new NotFoundException({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Emergency contact not found.',
      });
    }
    if (existing.deletedAt !== null) {
      // Idempotent — repeated deletes resolve cleanly. The audit log
      // (TS-100) carries one event per delete attempt for trust-&-
      // safety review purposes; the service does not double-write the
      // tombstone here.
      return;
    }

    await this.prisma.emergencyContact.update({
      where: { id: contactId },
      data: { deletedAt: new Date() },
      select: { id: true },
    });

    this.logger.log(
      { householdId, requesterUserId, contactId, action: 'remove' },
      'emergency contact removed',
    );
  }

  /**
   * Active-membership precondition (mirror of `HouseholdAccessService`).
   * 404 on missing household; 403 on no active membership.
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
      throw new ForbiddenException({
        type: 'about:blank',
        title: 'Forbidden',
        status: 403,
        detail: 'You do not have access to this household.',
      });
    }
  }
}

const CONTACT_SELECT = {
  id: true,
  householdId: true,
  name: true,
  relationship: true,
  phone: true,
  email: true,
  priority: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface ContactRow {
  readonly id: string;
  readonly householdId: string;
  readonly name: string;
  readonly relationship: string;
  readonly phone: string;
  readonly email: string | null;
  readonly priority: number;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function toDto(row: ContactRow): EmergencyContact {
  return {
    id: row.id,
    householdId: row.householdId,
    name: row.name,
    relationship: row.relationship,
    phone: row.phone,
    email: row.email,
    priority: row.priority,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
