/**
 * Local enum mirrors for the mandated-reporter workflow (TS-303a), plus
 * re-exports of the pieces that are now single-sourced in
 * `@taste-and-see/contracts` (TS-303c2b).
 *
 * Mirroring rationale for the two TYPES below, same as `incident-enums.ts`:
 * `@prisma/client` does not surface the generated enum types cleanly under our
 * `moduleResolution: "Node"` tsconfig, so the equivalent string-literal unions
 * are declared here. Drift against `prisma/schema.prisma` surfaces at the
 * first call that passes a non-listed string to Prisma; the unit suite
 * cross-pins the key sets.
 *
 * The transition MATRIX and the jurisdiction code list moved to contracts and
 * are re-exported rather than redeclared. They are consumed by the admin
 * console as well as by this service, and a console that offers a transition
 * the service will reject is a bug on a legal workflow — a second copy is
 * exactly how the two drift. This module keeps the local names
 * (`canTransition`) so no call site had to change.
 */

import {
  canAdvanceMandatedReporterCase,
  MANDATED_REPORTER_CASE_STATUSES,
  MANDATED_REPORTER_STATUS_TRANSITIONS,
  MANDATED_REPORTER_TERMINAL_STATUS,
  US_JURISDICTION_CODES,
  isUsJurisdictionCode,
  type UsJurisdictionCode,
} from '@taste-and-see/contracts';

export {
  MANDATED_REPORTER_CASE_STATUSES,
  MANDATED_REPORTER_STATUS_TRANSITIONS,
  MANDATED_REPORTER_TERMINAL_STATUS,
  US_JURISDICTION_CODES,
  isUsJurisdictionCode,
  type UsJurisdictionCode,
};

/** Local alias for the shared legality check — see the module doc-block. */
export const canTransition = canAdvanceMandatedReporterCase;

/** Mirrors `trust_safety.mandated_reporter_platform_role`. */
export type MandatedReporterPlatformRole = 'mandated' | 'permissive' | 'undetermined';

/** Mirrors `trust_safety.mandated_reporter_case_status`. */
export type MandatedReporterCaseStatus =
  | 'screening'
  | 'filing_prep'
  | 'filed'
  | 'not_reportable'
  | 'signed_off';
