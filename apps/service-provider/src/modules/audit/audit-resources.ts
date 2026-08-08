/**
 * Audit resource kinds for the provider bounded context (the
 * `resourceKind` column on the audit row). Snake_case slugs matching the
 * Prisma table names.
 *
 * TS-305a-followup-1. The three `provider:approve` write paths are the
 * ones that matter here: granting and revoking a credential, and moving
 * a tier. Every one of them changes what a provider is allowed to be
 * booked for, and until now none of them left a trail — a certification
 * could be revoked with nothing recording who did it or why.
 */
export const PROVIDER_AUDIT_RESOURCE = {
  certification: 'provider_certification',
  tier: 'provider_tier',
} as const;
