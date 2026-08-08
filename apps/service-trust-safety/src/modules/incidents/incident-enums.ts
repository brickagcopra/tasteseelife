/**
 * Local enum mirrors for the `trust_safety` Prisma enums. Same root cause as
 * TS-021-followup-2 / -followup-3 (documented in service-identity's
 * `kyc.service.ts`): the `@prisma/client` namespace re-exports type aliases
 * for the generated enums but does not surface them cleanly under our
 * `moduleResolution: "Node"` tsconfig. Following the established convention
 * in this codebase, we declare the equivalent string-literal unions locally.
 * Drift between this file and `prisma/schema.prisma` would surface at the
 * first call that passes a non-listed string to Prisma — the unit suite
 * cross-pins the surface (`sla.test.ts` asserts the severity key set).
 */

/** Mirrors `trust_safety.incident_severity`. */
export type IncidentSeverity = 'low' | 'medium' | 'high' | 'critical';

/** Mirrors `trust_safety.incident_status`. */
export type IncidentStatus = 'open' | 'triaging' | 'awaiting_review' | 'resolved';

/** Mirrors `trust_safety.incident_source`. */
export type IncidentSource = 'family' | 'senior' | 'provider' | 'concierge' | 'system';

/** Mirrors `trust_safety.incident_category`. */
export type IncidentCategory = 'welfare' | 'safety' | 'billing' | 'conduct';
