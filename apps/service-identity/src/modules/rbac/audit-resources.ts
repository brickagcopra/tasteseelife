/**
 * Audit resource kinds for the identity RBAC bounded context (TS-295; moved
 * here by TS-309a-followup-3).
 *
 * The `resourceKind` column on the audit row. One const per bounded context is
 * the shape `@taste-and-see/nest-audit` expects (TS-303b-followup-1) — the
 * emitter is shared, the resource vocabulary is not.
 *
 * **These strings are load-bearing beyond this service.** The RBAC History
 * view (TS-295) streams them via service-audit's `by-resource-kind` read, so
 * the web-admin page's `resourceKinds` CSV has to agree with this map; a
 * renamed kind silently empties that page rather than failing anything.
 */
export const RBAC_AUDIT_RESOURCE = {
  role: 'rbac_role',
  assignment: 'rbac_assignment',
  approval: 'rbac_approval',
  orgSecurityPolicy: 'org_security_policy',
  userImpersonation: 'user_impersonation',
} as const;
