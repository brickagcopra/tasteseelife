import { z } from 'zod';

/**
 * Server-side env for the provider portal (TS-122).
 *
 * Mirrors `apps/web-family/lib/env.ts`. Cookie names default to
 * `tas_provider_*` so the provider + family portals coexist on
 * neighbouring origins without cookie collision (a developer logged
 * into both portals locally should keep two distinct sessions).
 */
const EnvSchema = z
  .object({
    API_GATEWAY_BASE_URL: z
      .string()
      .url('API_GATEWAY_BASE_URL must be a valid URL (e.g. http://localhost:3000)'),
    /**
     * Override only when the deployment fronts the provider portal on a
     * different cookie scope than the runtime origin. Default `Lax` is
     * the secure-by-default choice (CLAUDE.md §3.1).
     */
    SESSION_COOKIE_NAME: z.string().default('tas_provider_access'),
    REFRESH_COOKIE_NAME: z.string().default('tas_provider_refresh'),
  })
  .strip();

export type WebProviderEnv = z.infer<typeof EnvSchema>;

let cached: WebProviderEnv | null = null;

export function loadEnv(): WebProviderEnv {
  if (cached !== null) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`web-provider env validation failed: ${detail}`);
  }
  cached = parsed.data;
  return cached;
}
