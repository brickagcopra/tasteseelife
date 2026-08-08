/**
 * Audit resource kinds for the trust & safety bounded context (the
 * `resourceKind` column on the audit row). Snake_case slugs matching the
 * Prisma table names.
 */
export const TRUST_SAFETY_AUDIT_RESOURCE = {
  incident: 'trust_safety_incident',
  mandatedReporterCase: 'trust_safety_mandated_reporter_case',
  mandatedReporterJurisdiction: 'trust_safety_mandated_reporter_jurisdiction',
} as const;
