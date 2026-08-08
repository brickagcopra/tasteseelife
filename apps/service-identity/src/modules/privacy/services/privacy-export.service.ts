import { Injectable, Logger } from '@nestjs/common';
import {
  PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
  type DataSubjectKind,
  type PrivacyExportSection,
  type PrivacyExportSlice,
  type PrivacyExportWithholding,
} from '@taste-and-see/contracts';

import { PrismaService } from '../../../prisma/prisma.service';

/**
 * service-identity's contribution to a data-subject export (TS-309b).
 *
 * The first implementation of the seam in
 * `packages/contracts/src/http/privacy-export-slice.schema.ts`, and therefore
 * the shape the other ~20 owning services mirror. Three things it establishes:
 *
 * **1. What identity actually holds about a person.** An account, the sign-ins
 * made from it, the second factors registered on it, the roles granted to it,
 * the identity checks run against it, and the privacy requests filed from it.
 * Six sections, each an explicit `select` — a `select`-less read here would
 * pull password hashes and MFA ciphertext into the same object graph as the
 * response, one careless spread away from the wire (CLAUDE.md §4.1).
 *
 * **2. What must never travel, and that saying so is part of the answer.**
 * Credentials, encrypted identity documents, the method by which a
 * verification was performed, and other people's user ids are all withheld —
 * and each is DECLARED in `withheld`, because an export that silently drops
 * them reads as complete and is not. That is the same lie as shipping a
 * partial ZIP, which TS-309b's entry rules out in as many words.
 *
 * **3. Which subjects identity can answer for at all.** `user` only. A senior
 * is a household record and a provider is a provider-directory record; neither
 * is keyed by a user id here. Answering `not_applicable` for those is a
 * structural fact about this service, deliberately distinct from "we looked and
 * found nothing about this person" (`no_records`), which is an answer about the
 * subject.
 */

export const PRIVACY_EXPORT_SERVICE_SLUG = 'service-identity';

/**
 * Everything identity holds and will not hand over, with the categorical
 * reason. Constant rather than computed: the list is a property of the service,
 * not of the subject, so a requester with no MFA method still learns that MFA
 * secrets are a thing this platform holds back — and a future column that
 * belongs here is a one-line addition beside its section rather than a
 * conditional nobody will maintain.
 */
const IDENTITY_WITHHELD: readonly PrivacyExportWithholding[] = Object.freeze([
  Object.freeze({
    key: 'password',
    label: 'Your password',
    reason: 'credential_material' as const,
  }),
  Object.freeze({
    key: 'session_tokens',
    label: 'The tokens behind your sign-in sessions',
    reason: 'credential_material' as const,
  }),
  Object.freeze({
    key: 'mfa_secrets',
    label: 'Your two-factor secrets and recovery codes',
    reason: 'credential_material' as const,
  }),
  Object.freeze({
    key: 'identity_check_documents',
    label: 'The identity documents you supplied for verification',
    reason: 'identity_evidence' as const,
  }),
  Object.freeze({
    key: 'request_verification_method',
    label: 'How we verified who you are on a privacy request',
    reason: 'security_control' as const,
  }),
  Object.freeze({
    key: 'staff_identities',
    label: 'Which member of our team approved or acted on your account',
    reason: 'third_party_data' as const,
  }),
]);

/**
 * Row shapes for each projection.
 *
 * Declared rather than inferred because `@prisma/client` resolves to the root
 * stub during this service's own `type-check` (the generated client lives in
 * the service's `node_modules/.prisma/client`), so the delegates are untyped
 * and an un-annotated `.map` callback silently becomes `any` — CLAUDE.md §2.1,
 * and the gotcha TS-303c2d hit on the incident read path. These interfaces are
 * also the second place the `select` is written down, so widening one without
 * the other is a compile error rather than an export that grew a column.
 */
interface SessionRow {
  readonly id: string;
  readonly familyId: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly rotatedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly impersonatorUserId: string | null;
}

interface MfaMethodRow {
  readonly id: string;
  readonly kind: string;
  readonly label: string | null;
  readonly confirmedAt: Date | null;
  readonly lastUsedAt: Date | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
}

interface RoleGrantRow {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  readonly role: { readonly name: string };
}

interface RoleApprovalRow {
  readonly id: string;
  readonly scopeType: string;
  readonly scopeId: string | null;
  readonly status: string;
  readonly expiresAt: Date | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
  readonly role: { readonly name: string };
}

interface KycRow {
  readonly id: string;
  readonly provider: string;
  readonly status: string;
  readonly verifiedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

interface PrivacyRequestRow {
  readonly id: string;
  readonly subjectKind: string;
  readonly subjectId: string;
  readonly selfService: boolean;
  readonly kind: string;
  readonly status: string;
  readonly note: string | null;
  readonly receivedAt: Date;
  readonly dueAt: Date;
  readonly extendedAt: Date | null;
  readonly verifiedAt: Date | null;
  readonly fulfilledAt: Date | null;
  readonly refusedAt: Date | null;
  readonly refusalReason: string | null;
  readonly withdrawnAt: Date | null;
}

@Injectable()
export class PrivacyExportService {
  private readonly logger = new Logger(PrivacyExportService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build this service's slice for one subject.
   *
   * `now` is injected rather than read from the clock inside so the artefact's
   * `generatedAt` is testable without a clock fake (CLAUDE.md §9.3).
   */
  async buildSlice(
    subjectKind: DataSubjectKind,
    subjectId: string,
    now: Date = new Date(),
  ): Promise<PrivacyExportSlice> {
    const base = {
      schemaVersion: PRIVACY_EXPORT_SLICE_SCHEMA_VERSION,
      service: PRIVACY_EXPORT_SERVICE_SLUG,
      subjectKind,
      subjectId,
      generatedAt: now.toISOString(),
    } as const;

    // A senior lives in service-household and a provider in service-provider.
    // Identity holds neither, and it is important that it says so in those
    // words: `no_records` would assert we searched a store that does not exist.
    if (subjectKind !== 'user') {
      return { ...base, outcome: 'not_applicable' };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: subjectId },
      select: {
        id: true,
        email: true,
        phone: true,
        status: true,
        mfaEnabled: true,
        emailVerifiedAt: true,
        failedLoginCount: true,
        lastFailedLoginAt: true,
        lockedUntil: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
      },
    });

    if (user === null) {
      this.logger.log({
        msg: 'privacy export slice: no identity records for subject',
        service: PRIVACY_EXPORT_SERVICE_SLUG,
        subjectKind,
      });
      return { ...base, outcome: 'no_records' };
    }

    const [sessions, mfaMethods, roleAssignments, identityChecks, privacyRequests] =
      await Promise.all([
        this.sessionSection(subjectId),
        this.mfaSection(subjectId),
        this.roleSection(subjectId),
        this.identityCheckSection(subjectId),
        this.privacyRequestSection(subjectId),
      ]);

    const sections: PrivacyExportSection[] = [
      {
        key: 'account',
        label: 'Your account',
        recordCount: 1,
        records: [
          {
            id: user.id,
            email: user.email,
            phone: user.phone,
            status: user.status,
            twoFactorEnabled: user.mfaEnabled,
            emailVerifiedAt: toIso(user.emailVerifiedAt),
            failedSignInCount: user.failedLoginCount,
            lastFailedSignInAt: toIso(user.lastFailedLoginAt),
            lockedUntil: toIso(user.lockedUntil),
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
            closedAt: toIso(user.deletedAt),
          },
        ],
      },
      sessions,
      mfaMethods,
      roleAssignments,
      identityChecks,
      privacyRequests,
    ];

    this.logger.log({
      msg: 'privacy export slice assembled',
      service: PRIVACY_EXPORT_SERVICE_SLUG,
      subjectKind,
      sectionCount: sections.length,
      recordCount: sections.reduce((total, section) => total + section.recordCount, 0),
    });

    return {
      ...base,
      outcome: 'held',
      sections,
      withheld: [...IDENTITY_WITHHELD],
    };
  }

  /**
   * Sign-in sessions.
   *
   * `tokenHash` is absent by `select`, not by mapping — it never enters the
   * process. `impersonatorUserId` becomes a BOOLEAN: that a staff member acted
   * on the account is the subject's business, but WHICH staff member is that
   * person's identity, and handing it over on a privacy request would be a
   * disclosure running the other way (hence the `third_party_data` withholding).
   */
  private async sessionSection(userId: string): Promise<PrivacyExportSection> {
    const rows: SessionRow[] = await this.prisma.refreshToken.findMany({
      where: { userId },
      select: {
        id: true,
        familyId: true,
        issuedAt: true,
        expiresAt: true,
        rotatedAt: true,
        revokedAt: true,
        ip: true,
        userAgent: true,
        impersonatorUserId: true,
      },
      orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
    });

    return {
      key: 'sign_in_sessions',
      label: 'Your sign-in sessions',
      recordCount: rows.length,
      records: rows.map((row) => ({
        id: row.id,
        sessionFamilyId: row.familyId,
        signedInAt: row.issuedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        renewedAt: toIso(row.rotatedAt),
        endedAt: toIso(row.revokedAt),
        ipAddress: row.ip,
        device: row.userAgent,
        startedByOurTeamOnYourBehalf: row.impersonatorUserId !== null,
      })),
    };
  }

  /** Registered second factors — never the secret, the IV, or the auth tag. */
  private async mfaSection(userId: string): Promise<PrivacyExportSection> {
    const rows: MfaMethodRow[] = await this.prisma.mfaMethod.findMany({
      where: { userId },
      select: {
        id: true,
        kind: true,
        label: true,
        confirmedAt: true,
        lastUsedAt: true,
        createdAt: true,
        deletedAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    return {
      key: 'two_factor_methods',
      label: 'Your two-factor sign-in methods',
      recordCount: rows.length,
      records: rows.map((row) => ({
        id: row.id,
        method: row.kind,
        name: row.label,
        confirmedAt: toIso(row.confirmedAt),
        lastUsedAt: toIso(row.lastUsedAt),
        addedAt: row.createdAt.toISOString(),
        removedAt: toIso(row.deletedAt),
      })),
    };
  }

  /**
   * Roles granted on the account, and any requests made to change them.
   *
   * Both drop the staff ids they carry (`grantedByUserId`, `requestedByUserId`,
   * `approvedByUserId`) for the reason in `IDENTITY_WITHHELD`. `decisionNote`
   * goes too: it is free text an operator wrote about the request, not a field
   * the subject supplied, and it can name a third party.
   */
  private async roleSection(userId: string): Promise<PrivacyExportSection> {
    const [grants, approvals]: [RoleGrantRow[], RoleApprovalRow[]] = await Promise.all([
      this.prisma.userRole.findMany({
        where: { userId },
        select: {
          id: true,
          scopeType: true,
          scopeId: true,
          expiresAt: true,
          createdAt: true,
          revokedAt: true,
          role: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.roleAssignmentApproval.findMany({
        where: { userId },
        select: {
          id: true,
          scopeType: true,
          scopeId: true,
          status: true,
          expiresAt: true,
          decidedAt: true,
          createdAt: true,
          role: { select: { name: true } },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const records = [
      ...grants.map((row) => ({
        kind: 'granted' as const,
        id: row.id,
        role: row.role.name,
        scope: row.scopeType,
        scopeId: row.scopeId,
        grantedAt: row.createdAt.toISOString(),
        expiresAt: toIso(row.expiresAt),
        revokedAt: toIso(row.revokedAt),
      })),
      ...approvals.map((row) => ({
        kind: 'requested' as const,
        id: row.id,
        role: row.role.name,
        scope: row.scopeType,
        scopeId: row.scopeId,
        status: row.status,
        requestedAt: row.createdAt.toISOString(),
        decidedAt: toIso(row.decidedAt),
        expiresAt: toIso(row.expiresAt),
      })),
    ];

    return {
      key: 'roles',
      label: 'Roles on your account',
      recordCount: records.length,
      records,
    };
  }

  /**
   * Identity / KYC checks.
   *
   * Status and timing only. The encrypted payload stays in the database
   * (`identity_evidence`), and `externalId` — the vendor's handle for the check
   * — stays too: it is a key into a third-party system, not a fact about the
   * subject, and TS-305a made the same call for Checkr handles on the provider
   * dossier.
   */
  private async identityCheckSection(userId: string): Promise<PrivacyExportSection> {
    const rows: KycRow[] = await this.prisma.kycRecord.findMany({
      where: { userId },
      select: {
        id: true,
        provider: true,
        status: true,
        verifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });

    return {
      key: 'identity_checks',
      label: 'Identity verification checks',
      recordCount: rows.length,
      records: rows.map((row) => ({
        id: row.id,
        checkedBy: row.provider,
        status: row.status,
        verifiedAt: toIso(row.verifiedAt),
        startedAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Privacy requests filed FROM this account (TS-309a rows).
   *
   * Keyed on `requesterUserId`, not on subject: this section answers "what did
   * you ask us for", and a request someone else filed about this subject is
   * that person's record. `verificationMethod` and `verifiedByUserId` are
   * withheld; `refusalNote` is an operator's free text and goes with them.
   */
  private async privacyRequestSection(userId: string): Promise<PrivacyExportSection> {
    const rows: PrivacyRequestRow[] = await this.prisma.dataSubjectRequest.findMany({
      where: { requesterUserId: userId },
      select: {
        id: true,
        subjectKind: true,
        subjectId: true,
        selfService: true,
        kind: true,
        status: true,
        note: true,
        receivedAt: true,
        dueAt: true,
        extendedAt: true,
        verifiedAt: true,
        fulfilledAt: true,
        refusedAt: true,
        refusalReason: true,
        withdrawnAt: true,
      },
      orderBy: [{ receivedAt: 'desc' }, { id: 'asc' }],
    });

    return {
      key: 'privacy_requests',
      label: 'Privacy requests you have made',
      recordCount: rows.length,
      records: rows.map((row) => ({
        id: row.id,
        about: row.subjectKind,
        aboutId: row.subjectId,
        aboutYourself: row.selfService,
        request: row.kind,
        status: row.status,
        yourNote: row.note,
        receivedAt: row.receivedAt.toISOString(),
        dueAt: row.dueAt.toISOString(),
        extendedAt: toIso(row.extendedAt),
        verifiedAt: toIso(row.verifiedAt),
        fulfilledAt: toIso(row.fulfilledAt),
        refusedAt: toIso(row.refusedAt),
        refusalReason: row.refusalReason,
        withdrawnAt: toIso(row.withdrawnAt),
      })),
    };
  }
}

function toIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}
