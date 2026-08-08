import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Each authenticated portal declares `dynamic = 'force-dynamic'` in its ROOT
 * layout, and does not re-declare it per page.
 *
 * **Why (TS-505c-followup-1).** `web-admin`, `web-family` and `web-provider`
 * are authenticated applications: every page reads a session cookie and calls
 * the gateway for one signed-in user. Nothing in them can be statically
 * generated — and trying to is what broke `next build`.
 *
 * The mechanism is worth stating, because it is not obvious. Each portal's
 * `readAccessToken()` calls `loadEnv()` *before* `cookies()`. During static
 * generation `cookies()` is the signal Next uses to discover a route is
 * dynamic and bail out of prerendering — but the env read throws first, so the
 * build died with `API_GATEWAY_BASE_URL: Required` instead of quietly marking
 * the route dynamic. `API_GATEWAY_BASE_URL` is a **runtime** value: one image
 * serves dev, staging and prod, and the URL arrives from the k8s ConfigMap.
 * There was never a correct value to hand the build.
 *
 * That made this far more than a local-DX annoyance. `infra/docker/
 * nextjs.Dockerfile` runs `pnpm --filter "$SERVICE_PACKAGE..." build` with
 * exactly two build-args, `SERVICE_PATH` and `SERVICE_PACKAGE` — no gateway
 * URL — so **all three portal images failed the same way**, and none of them
 * had ever built.
 *
 * The property was previously declared per page, and **34 of 111 pages had
 * been missed**. Declaring it once in the root layout is why this guard checks
 * the layout and *also* checks that pages have stopped carrying their own
 * copies: a per-page opt-in is what produced the 34 misses, and re-introducing
 * one copy is how the habit comes back.
 *
 * Route handlers (`route.ts`) are deliberately exempt — a layout's segment
 * config does not apply to them, so those keep their own declaration.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** The authenticated portals. `web-marketing` is excluded on purpose: it is a
 *  public, ISR-rendered site with no session, and forcing it dynamic would
 *  throw away the caching its whole design depends on. */
const PORTALS = ['web-admin', 'web-family', 'web-provider'] as const;

const DECLARATION = "export const dynamic = 'force-dynamic';";

function pageFiles(appDir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === '.next') continue;
        walk(full);
        continue;
      }
      // `.tsx` only — `route.ts` handlers are exempt (see doc-comment).
      if (entry.endsWith('.tsx')) found.push(full);
    }
  };
  walk(appDir);
  return found;
}

describe('portal dynamic rendering', () => {
  it('discovers the portal app trees', () => {
    // A path that stops resolving must not turn "no offenders" into "no data".
    for (const portal of PORTALS) {
      expect(existsSync(path.join(REPO_ROOT, 'apps', portal, 'app', 'layout.tsx')), portal).toBe(
        true,
      );
    }
    const total = PORTALS.flatMap((p) => pageFiles(path.join(REPO_ROOT, 'apps', p, 'app'))).length;
    expect(total).toBeGreaterThan(100);
  });

  it('declares force-dynamic in every portal root layout', () => {
    const offenders = PORTALS.filter((portal) => {
      const layout = path.join(REPO_ROOT, 'apps', portal, 'app', 'layout.tsx');
      return !readFileSync(layout, 'utf8').includes(DECLARATION);
    });

    expect(
      offenders,
      'These portals can be statically prerendered, which fails the build with ' +
        '`API_GATEWAY_BASE_URL: Required` — a runtime value the build has no correct answer for, ' +
        'and which the Docker image build does not supply either. Add `export const dynamic = ' +
        "'force-dynamic';` to the root layout.\n" +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('does not re-declare it on individual pages or layouts', () => {
    const offenders = PORTALS.flatMap((portal) => {
      const appDir = path.join(REPO_ROOT, 'apps', portal, 'app');
      const rootLayout = path.join(appDir, 'layout.tsx');
      return pageFiles(appDir)
        .filter((file) => file !== rootLayout)
        .filter((file) => readFileSync(file, 'utf8').includes(DECLARATION))
        .map((file) => path.relative(REPO_ROOT, file));
    });

    expect(
      offenders,
      'The root layout already forces dynamic rendering for the whole app. A per-page copy is ' +
        'redundant, and per-page opt-in is exactly what left 34 of 111 pages without it. Remove ' +
        'these.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
