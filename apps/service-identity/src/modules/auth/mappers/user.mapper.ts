import type { SignupResponse, UserStatus } from '@taste-and-see/contracts';

/**
 * Subset of Prisma `User` columns required to render the signup
 * response. Declared explicitly so a future schema column (token
 * version, recovery codes, etc.) cannot accidentally ride into a
 * response just because someone widened the service's Prisma `select`
 * (CLAUDE.md §3.3: "All outbound responses pass through DTO mappers
 * — never return raw Prisma objects to the client").
 *
 * Fields deliberately NOT exposed:
 *  - `passwordHash` — secret material; never crosses the service
 *    boundary, never logged, never returned in any response.
 *  - `mfaEnabled` — internal flag used for login orchestration; the
 *    client learns about MFA via the login flow (TS-023), not signup.
 *  - `deletedAt` — internal soft-delete tombstone; clients always
 *    operate on non-deleted rows.
 *  - `updatedAt`, `emailVerifiedAt` — irrelevant at signup time
 *    (`updatedAt === createdAt`, `emailVerifiedAt` is always null at
 *    creation). When email-verification ships these become part of a
 *    distinct `account-status` DTO.
 */
export interface SignupResponseSource {
  readonly id: string;
  readonly email: string;
  readonly phone: string | null;
  /**
   * Mirrors `identity.user_status` (TS-020 schema) — kept as the
   * contract-side `UserStatus` union to dodge a quirk where Prisma's
   * `UserStatus` enum re-exports through nested `export *` chains
   * inconsistently across `verbatimModuleSyntax` / `isolatedModules`
   * tsc invocations. Both enums are the same four-value string union;
   * if the schema ever drifts the contract test suite catches it.
   */
  readonly status: UserStatus;
  readonly createdAt: Date;
}

export function toSignupResponse(user: SignupResponseSource): SignupResponse {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    status: user.status,
    createdAt: user.createdAt.toISOString(),
  };
}
