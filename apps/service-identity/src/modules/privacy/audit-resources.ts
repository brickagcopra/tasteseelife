/**
 * Audit resource kinds for the privacy bounded context (TS-309a).
 *
 * The `resourceKind` column on the audit row. One const per service is the
 * shape `@taste-and-see/nest-audit` expects (TS-303b-followup-1) — the emitter
 * is shared, the resource vocabulary is not.
 */
export const PRIVACY_AUDIT_RESOURCE = {
  dataSubjectRequest: 'data_subject_request',
} as const;
