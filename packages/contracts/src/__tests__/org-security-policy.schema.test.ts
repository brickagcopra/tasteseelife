import { describe, expect, it } from 'vitest';

import {
  ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID,
  OrgSecurityPoliciesListResponseSchema,
  OrgSecurityPolicyRecordSchema,
  OrgSecurityPolicyResponseSchema,
  OrgSecurityPolicyScopeIdSchema,
  UpsertOrgSecurityPolicyRequestSchema,
} from '../http/org-security-policy.schema';

const VALID_RECORD = {
  id: 'pol_ck2x9y1z80000abc',
  scopeId: 'tenant_abc',
  ssoRequired: true,
  createdAt: '2026-07-02T12:00:00.000Z',
  updatedAt: '2026-07-02T12:00:00.000Z',
};

describe('OrgSecurityPolicyScopeIdSchema', () => {
  it('accepts CUID-shaped tenant ids and the global sentinel', () => {
    expect(OrgSecurityPolicyScopeIdSchema.safeParse('tenant_abc').success).toBe(true);
    expect(
      OrgSecurityPolicyScopeIdSchema.safeParse(ORG_SECURITY_POLICY_GLOBAL_SCOPE_ID).success,
    ).toBe(true);
  });

  it('trims surrounding whitespace', () => {
    const parsed = OrgSecurityPolicyScopeIdSchema.safeParse('  tenant_abc  ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('tenant_abc');
  });

  it('rejects empty, over-long, and non-token inputs', () => {
    expect(OrgSecurityPolicyScopeIdSchema.safeParse('').success).toBe(false);
    expect(OrgSecurityPolicyScopeIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
    expect(OrgSecurityPolicyScopeIdSchema.safeParse('bad scope!').success).toBe(false);
    expect(OrgSecurityPolicyScopeIdSchema.safeParse('a/b').success).toBe(false);
  });
});

describe('OrgSecurityPolicyRecordSchema', () => {
  it('accepts a full record', () => {
    expect(OrgSecurityPolicyRecordSchema.safeParse(VALID_RECORD).success).toBe(true);
  });

  it('rejects unknown fields (strict)', () => {
    expect(OrgSecurityPolicyRecordSchema.safeParse({ ...VALID_RECORD, extra: 1 }).success).toBe(
      false,
    );
  });

  it('rejects non-ISO timestamps', () => {
    expect(
      OrgSecurityPolicyRecordSchema.safeParse({ ...VALID_RECORD, updatedAt: 'yesterday' }).success,
    ).toBe(false);
  });
});

describe('UpsertOrgSecurityPolicyRequestSchema', () => {
  it('requires ssoRequired as a boolean and nothing else', () => {
    expect(UpsertOrgSecurityPolicyRequestSchema.safeParse({ ssoRequired: false }).success).toBe(
      true,
    );
    expect(UpsertOrgSecurityPolicyRequestSchema.safeParse({}).success).toBe(false);
    expect(UpsertOrgSecurityPolicyRequestSchema.safeParse({ ssoRequired: 'true' }).success).toBe(
      false,
    );
    expect(
      UpsertOrgSecurityPolicyRequestSchema.safeParse({ ssoRequired: true, scopeId: 'x' }).success,
    ).toBe(false);
  });
});

describe('response envelopes', () => {
  it('parses the list and single-policy envelopes', () => {
    expect(
      OrgSecurityPoliciesListResponseSchema.safeParse({ policies: [VALID_RECORD] }).success,
    ).toBe(true);
    expect(OrgSecurityPolicyResponseSchema.safeParse({ policy: VALID_RECORD }).success).toBe(true);
  });
});
