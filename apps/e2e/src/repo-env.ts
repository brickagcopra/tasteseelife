import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The E2E fleet's base environment is the repository's own `.env.example`
 * (TS-505).
 *
 * **Why that file and not a private fixture.** TS-504 established that
 * `.env.example` is the complete, boot-capable documented environment: every
 * one of the 30 apps' real `loadEnv()` accepts it, verified by executing the
 * schemas rather than diffing key names. Reusing it here means the E2E suite
 * exercises the same configuration a developer or a fresh clone gets. The
 * inverse property is the valuable one: if someone adds a required env var
 * and forgets `.env.example`, the E2E fleet stops booting — the suite becomes
 * a standing check on the documented environment instead of a parallel copy
 * of it that drifts silently.
 *
 * Only three classes of value are overridden per service (see `fleet.ts`):
 * the database URL (an isolated E2E database), the port (pinned explicitly so
 * a drifting schema default cannot silently move the fleet), and a handful of
 * local-transport settings that the shipped defaults deliberately set for
 * production (`REFRESH_COOKIE_SECURE`).
 */

/**
 * Repository root — `apps/e2e/src` → three levels up. `__dirname` (not
 * `import.meta.url`): the package is CommonJS, which is what Playwright's
 * transpiler and `tsc` both compile these sources as.
 */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export const ENV_EXAMPLE_PATH = resolve(REPO_ROOT, '.env.example');

/**
 * Parse a dotenv-style file into a plain record.
 *
 * Deliberately minimal — no quote stripping, no `export ` prefix handling, no
 * variable interpolation. `.env.example` uses none of those, and a parser that
 * accepts more than the file contains would let the file grow syntax that the
 * real consumers (docker-compose, `dotenv`) may or may not agree on. Values
 * are taken verbatim up to the end of the line, so `MFA_TOTP_ISSUER=Taste & See`
 * survives intact and a trailing `#` is part of the value, not a comment.
 */
export function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }

    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }

    const key = line.slice(0, eq).trim();
    // `KEY=` with no value is a legitimate empty string, and several schemas
    // accept it — so an empty value is kept, not skipped. `.env.example` has
    // no such line today (TS-504-followup-2 commented out `SENTRY_DSN=`, the
    // one this comment used to name, because nothing initialises Sentry yet),
    // but dropping the branch would silently change how the next one parses.
    out[key] = line.slice(eq + 1).trim();
  }

  return out;
}

let cached: Record<string, string> | undefined;

/** The parsed `.env.example`, read once per process. */
export function loadRepoEnvExample(): Record<string, string> {
  if (cached === undefined) {
    cached = parseDotenv(readFileSync(ENV_EXAMPLE_PATH, 'utf8'));
  }
  return cached;
}
