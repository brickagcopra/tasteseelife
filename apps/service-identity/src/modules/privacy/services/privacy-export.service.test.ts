import 'reflect-metadata';

import { PrivacyExportSliceSchema } from '@taste-and-see/contracts';
import { describe, expect, it } from 'vitest';

import type { PrismaService } from '../../../prisma/prisma.service';

import { PrivacyExportService } from './privacy-export.service';

/**
 * Unit tests for identity's export contribution (TS-309b).
 *
 * The assertions that carry weight, in order:
 *   - **no credential material leaves the service.** Serialise the whole slice
 *     and look for it — a per-field assertion only catches the fields somebody
 *     thought to check, and this is the failure that cannot be walked back;
 *   - "we hold nothing about this person" and "we never hold this kind of
 *     person" are different answers, and neither is an error;
 *   - the assembled slice satisfies the published contract, `recordCount`
 *     cross-check included;
 *   - the staff member behind an impersonated session becomes a boolean;
 *   - every withholding is declared rather than silently applied.
 */

const NOW = new Date('2026-07-27T09:30:00.000Z');

const USER_ROW = {
  id: 'usr_1',
  email: 'margaret@example.com',
  phone: '+15550100',
  status: 'active',
  mfaEnabled: true,
  emailVerifiedAt: new Date('2026-01-02T00:00:00.000Z'),
  failedLoginCount: 1,
  lastFailedLoginAt: new Date('2026-05-01T00:00:00.000Z'),
  lockedUntil: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  deletedAt: null,
};

const SESSION_ROW = {
  id: 'rt_1',
  familyId: 'fam_1',
  issuedAt: new Date('2026-06-01T00:00:00.000Z'),
  expiresAt: new Date('2026-07-01T00:00:00.000Z'),
  rotatedAt: null,
  revokedAt: null,
  ip: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
  impersonatorUserId: 'usr_staff_secret',
  // Present on the model, absent from the `select` — included here so a
  // regression that widens the projection is caught by the leak test below.
  tokenHash: 'hash_do_not_export',
};

const MFA_ROW = {
  id: 'mfa_1',
  kind: 'totp',
  label: 'Phone',
  confirmedAt: new Date('2026-01-03T00:00:00.000Z'),
  lastUsedAt: new Date('2026-06-02T00:00:00.000Z'),
  createdAt: new Date('2026-01-03T00:00:00.000Z'),
  deletedAt: null,
  secretCiphertext: Buffer.from('totp_shared_secret'),
};

const GRANT_ROW = {
  id: 'ur_1',
  scopeType: 'household',
  scopeId: 'hh_1',
  expiresAt: null,
  createdAt: new Date('2026-01-04T00:00:00.000Z'),
  revokedAt: null,
  role: { name: 'family_payer' },
};

const APPROVAL_ROW = {
  id: 'ra_1',
  scopeType: 'global',
  scopeId: null,
  status: 'approved',
  expiresAt: null,
  decidedAt: new Date('2026-02-01T00:00:00.000Z'),
  createdAt: new Date('2026-01-31T00:00:00.000Z'),
  role: { name: 'operations_manager' },
  approvedByUserId: 'usr_approver_secret',
  decisionNote: 'approved after a call with the ops lead',
};

const KYC_ROW = {
  id: 'kyc_1',
  provider: 'stripe',
  status: 'verified',
  verifiedAt: new Date('2026-01-05T00:00:00.000Z'),
  createdAt: new Date('2026-01-05T00:00:00.000Z'),
  updatedAt: new Date('2026-01-05T00:00:00.000Z'),
  externalId: 'stripe_handle_do_not_export',
};

const DSAR_ROW = {
  id: 'dsr_1',
  subjectKind: 'user',
  subjectId: 'usr_1',
  selfService: true,
  kind: 'access',
  status: 'in_progress',
  note: 'Please send everything you have.',
  receivedAt: new Date('2026-07-20T00:00:00.000Z'),
  dueAt: new Date('2026-09-03T00:00:00.000Z'),
  extendedAt: null,
  verifiedAt: new Date('2026-07-20T00:00:00.000Z'),
  fulfilledAt: null,
  refusedAt: null,
  refusalReason: null,
  withdrawnAt: null,
  verificationMethod: 'mfa_backed_session_do_not_export',
};

interface HarnessOptions {
  readonly user?: Record<string, unknown> | null;
  readonly sessions?: readonly Record<string, unknown>[];
  readonly mfaMethods?: readonly Record<string, unknown>[];
  readonly grants?: readonly Record<string, unknown>[];
  readonly approvals?: readonly Record<string, unknown>[];
  readonly kycRecords?: readonly Record<string, unknown>[];
  readonly privacyRequests?: readonly Record<string, unknown>[];
}

function harness(options: HarnessOptions = {}): PrivacyExportService {
  const prisma = {
    user: {
      findUnique: async () => (options.user === undefined ? USER_ROW : options.user),
    },
    refreshToken: { findMany: async () => options.sessions ?? [SESSION_ROW] },
    mfaMethod: { findMany: async () => options.mfaMethods ?? [MFA_ROW] },
    userRole: { findMany: async () => options.grants ?? [GRANT_ROW] },
    roleAssignmentApproval: { findMany: async () => options.approvals ?? [APPROVAL_ROW] },
    kycRecord: { findMany: async () => options.kycRecords ?? [KYC_ROW] },
    dataSubjectRequest: { findMany: async () => options.privacyRequests ?? [DSAR_ROW] },
  } as unknown as PrismaService;

  return new PrivacyExportService(prisma);
}

describe('PrivacyExportService.buildSlice', () => {
  it('produces a slice that satisfies the published contract', async () => {
    const slice = await harness().buildSlice('user', 'usr_1', NOW);

    // Parses, so `recordCount` agrees with `records` in every section and no
    // section carries an undeclared field (the schema is `.strict()`).
    const parsed = PrivacyExportSliceSchema.parse(slice);
    expect(parsed.outcome).toBe('held');
    expect(parsed.service).toBe('service-identity');
    expect(parsed.generatedAt).toBe(NOW.toISOString());
  });

  it('never emits credential material, identity evidence, or a staff id', async () => {
    const slice = await harness().buildSlice('user', 'usr_1', NOW);
    const serialised = JSON.stringify(slice);

    for (const forbidden of [
      'hash_do_not_export',
      'totp_shared_secret',
      'stripe_handle_do_not_export',
      'mfa_backed_session_do_not_export',
      'usr_staff_secret',
      'usr_approver_secret',
      'approved after a call with the ops lead',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('reduces an impersonated session to a boolean', async () => {
    const slice = await harness().buildSlice('user', 'usr_1', NOW);
    if (slice.outcome !== 'held') throw new Error('expected a held slice');

    const sessions = slice.sections.find((section) => section.key === 'sign_in_sessions');
    expect(sessions?.records[0]?.startedByOurTeamOnYourBehalf).toBe(true);

    const plainSlice = await harness({
      sessions: [{ ...SESSION_ROW, impersonatorUserId: null }],
    }).buildSlice('user', 'usr_1', NOW);
    if (plainSlice.outcome !== 'held') throw new Error('expected a held slice');
    const plain = plainSlice.sections.find((section) => section.key === 'sign_in_sessions');
    expect(plain?.records[0]?.startedByOurTeamOnYourBehalf).toBe(false);
  });

  it('declares every withholding, including for a subject who has none of it', async () => {
    const slice = await harness({
      sessions: [],
      mfaMethods: [],
      grants: [],
      approvals: [],
      kycRecords: [],
      privacyRequests: [],
    }).buildSlice('user', 'usr_1', NOW);
    if (slice.outcome !== 'held') throw new Error('expected a held slice');

    // The list is a property of the service, not of the subject: a user with no
    // MFA method still learns that MFA secrets are held back.
    expect(slice.withheld.map((entry) => entry.key)).toEqual([
      'password',
      'session_tokens',
      'mfa_secrets',
      'identity_check_documents',
      'request_verification_method',
      'staff_identities',
    ]);
    expect(slice.withheld.every((entry) => entry.reason.length > 0)).toBe(true);
  });

  it('returns no_records for a user id it does not know', async () => {
    const slice = await harness({ user: null }).buildSlice('user', 'usr_missing', NOW);

    expect(slice.outcome).toBe('no_records');
    expect(PrivacyExportSliceSchema.parse(slice).subjectId).toBe('usr_missing');
  });

  it.each(['senior', 'provider'] as const)(
    'returns not_applicable for a %s — identity holds accounts, not that directory',
    async (subjectKind) => {
      const slice = await harness().buildSlice(subjectKind, 'sen_1', NOW);

      // Distinct from `no_records`: claiming we searched a store identity does
      // not own would misrepresent the answer.
      expect(slice.outcome).toBe('not_applicable');
      expect(PrivacyExportSliceSchema.parse(slice).subjectKind).toBe(subjectKind);
    },
  );

  it('holds the account section even when every other section is empty', async () => {
    const slice = await harness({
      sessions: [],
      mfaMethods: [],
      grants: [],
      approvals: [],
      kycRecords: [],
      privacyRequests: [],
    }).buildSlice('user', 'usr_1', NOW);
    if (slice.outcome !== 'held') throw new Error('expected a held slice');

    expect(slice.sections.map((section) => section.key)).toEqual([
      'account',
      'sign_in_sessions',
      'two_factor_methods',
      'roles',
      'identity_checks',
      'privacy_requests',
    ]);
    expect(slice.sections[0]?.recordCount).toBe(1);
    expect(slice.sections.slice(1).every((section) => section.recordCount === 0)).toBe(true);
  });

  it('merges granted and requested roles into one section, labelled by kind', async () => {
    const slice = await harness().buildSlice('user', 'usr_1', NOW);
    if (slice.outcome !== 'held') throw new Error('expected a held slice');

    const roles = slice.sections.find((section) => section.key === 'roles');
    expect(roles?.recordCount).toBe(2);
    expect(roles?.records.map((record) => record.kind)).toEqual(['granted', 'requested']);
    expect(roles?.records.map((record) => record.role)).toEqual([
      'family_payer',
      'operations_manager',
    ]);
  });

  it("carries the requester's own note but not an operator's", async () => {
    const slice = await harness().buildSlice('user', 'usr_1', NOW);
    if (slice.outcome !== 'held') throw new Error('expected a held slice');

    const requests = slice.sections.find((section) => section.key === 'privacy_requests');
    expect(requests?.records[0]?.yourNote).toBe('Please send everything you have.');
    expect(requests?.records[0]).not.toHaveProperty('refusalNote');
    expect(requests?.records[0]).not.toHaveProperty('verificationMethod');
  });
});
