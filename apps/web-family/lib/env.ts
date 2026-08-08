import { z } from 'zod';

/**
 * Server-side env for the family portal (TS-121).
 *
 * Validated lazily on first read. `API_GATEWAY_BASE_URL` is the only
 * required value at boot — every server action and protected page
 * routes through it. The cookie-name constants are exposed so the
 * middleware + server actions reference the same key strings.
 */
const EnvSchema = z
  .object({
    API_GATEWAY_BASE_URL: z
      .string()
      .url('API_GATEWAY_BASE_URL must be a valid URL (e.g. http://localhost:3000)'),
    /**
     * Override only when the deployment fronts the family portal on a
     * different cookie scope than the runtime origin. Default `Lax` is
     * the secure-by-default choice (CLAUDE.md §3.1).
     */
    SESSION_COOKIE_NAME: z.string().default('tas_family_access'),
    REFRESH_COOKIE_NAME: z.string().default('tas_family_refresh'),
    /**
     * Public-facing URL the portal runs at (e.g. https://app.tasteandsee.com).
     * Used to build the `successUrl` / `cancelUrl` we hand to Stripe
     * Checkout so the hosted page can redirect the customer back to the
     * portal after payment. Defaults to localhost for local dev; CI sets
     * the deployed value.
     */
    PORTAL_BASE_URL: z
      .string()
      .url('PORTAL_BASE_URL must be a valid URL (e.g. http://localhost:3100)')
      .default('http://localhost:3100'),
  })
  .strip();

export type WebFamilyEnv = z.infer<typeof EnvSchema>;

let cached: WebFamilyEnv | null = null;

export function loadEnv(): WebFamilyEnv {
  if (cached !== null) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`web-family env validation failed: ${detail}`);
  }
  cached = parsed.data;
  return cached;
}
