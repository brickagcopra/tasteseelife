import { z } from 'zod';

/**
 * Server-side env for the admin console (TS-123).
 *
 * Mirrors `apps/web-provider/lib/env.ts` / `apps/web-family/lib/env.ts`.
 * Cookie names default to `tas_admin_*` so the admin / family / provider
 * portals coexist on neighbouring origins without colliding cookie jars
 * (a developer simultaneously logged into all three locally keeps three
 * distinct sessions). In production the three portals are deployed to
 * sibling subdomains (e.g. `app.`, `pros.`, `admin.`) where the distinct
 * names also protect against a single browser stomping the admin
 * session when an operator is also a family member.
 */
const EnvSchema = z
  .object({
    API_GATEWAY_BASE_URL: z
      .string()
      .url('API_GATEWAY_BASE_URL must be a valid URL (e.g. http://localhost:3000)'),
    SESSION_COOKIE_NAME: z.string().default('tas_admin_access'),
    REFRESH_COOKIE_NAME: z.string().default('tas_admin_refresh'),
    /**
     * Short-lived cookie carrying the MFA challenge token between the
     * login and verify steps. The token itself is a single-use JWT
     * minted by service-identity (expires in MFA_CHALLENGE_TTL_SECONDS,
     * default 300s — see service-identity/env.ts); the cookie wraps it
     * so the verify form does not have to re-prompt for credentials.
     */
    MFA_CHALLENGE_COOKIE_NAME: z.string().default('tas_admin_mfa_challenge'),
    /**
     * TS-297 impersonation cookies. The access cookie carries the
     * impersonation session's bearer token (HttpOnly, short-lived — it
     * powers the "Impersonating …" banner's `/me` call); the family
     * cookie carries the session family id so "End impersonation"
     * still works after the 15-minute access token lapses.
     */
    IMPERSONATION_COOKIE_NAME: z.string().default('tas_admin_impersonation'),
    IMPERSONATION_FAMILY_COOKIE_NAME: z.string().default('tas_admin_impersonation_family'),
  })
  .strip();

export type WebAdminEnv = z.infer<typeof EnvSchema>;

let cached: WebAdminEnv | null = null;

export function loadEnv(): WebAdminEnv {
  if (cached !== null) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`web-admin env validation failed: ${detail}`);
  }
  cached = parsed.data;
  return cached;
}
