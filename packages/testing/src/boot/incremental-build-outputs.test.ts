import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * `.tsbuildinfo` must be managed alongside `dist/`, everywhere.
 *
 * **The defect this guards.** The shared base tsconfig sets
 * `incremental: true`, so `tsc -p tsconfig.build.json` consults
 * `tsconfig.build.tsbuildinfo` to decide what to re-emit. If that file
 * survives while `dist/` does not, `tsc` concludes everything is up to date,
 * **emits nothing, and exits 0** — a build that reports success and produces
 * no artifact.
 *
 * Two mechanisms used to make exactly that happen:
 *
 *   - `turbo.json`'s `build` task did not list `*.tsbuildinfo` as an output, so
 *     turbo saved and restored `dist/` without it. A cached `dist/` restored
 *     over a newer incremental state is a pair that disagrees.
 *   - every `clean` script was `rimraf dist`, so `pnpm clean && pnpm build`
 *     deliberately produced the disagreeing pair and then no-opped.
 *
 * `worker-identity-janitor` and `worker-certification-renewal` were both found
 * (TS-505 worker boot sweep) sitting on a `dist/` missing whole directories
 * that no rebuild could repair; deleting the `.tsbuildinfo` by hand was the
 * only way out. Neither app's unit suite could see it — the suites compile from
 * `src/`, not from `dist/`.
 *
 * **Why a text assertion.** Both properties are facts about configuration
 * files, and reading them is the whole check. Reproducing the failure
 * behaviourally would mean running `tsc` twice per package with a doctored
 * filesystem, which is slower and asserts less clearly. Same posture as
 * `service-ports.test.ts`, which reads env schemas as text because a declared
 * default is a syntactic fact.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');

/** Both incremental artifacts tsc can write here: the build config's and the type-check config's. */
const TSBUILDINFO_NAMES = ['tsconfig.build.tsbuildinfo', 'tsconfig.tsbuildinfo'] as const;

interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly buildScript: string | undefined;
  readonly cleanScript: string | undefined;
}

function readWorkspacePackages(): WorkspacePackage[] {
  const roots = [
    path.join(REPO_ROOT, 'apps'),
    path.join(REPO_ROOT, 'apps', 'workers'),
    path.join(REPO_ROOT, 'packages'),
  ];

  const out: WorkspacePackage[] = [];
  for (const root of roots) {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      const dir = path.join(root, entry.name);
      let raw: string;
      try {
        raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
      } catch {
        continue;
      }
      const parsed = JSON.parse(raw) as {
        name?: string;
        scripts?: Record<string, string>;
      };
      out.push({
        name: parsed.name ?? entry.name,
        dir,
        buildScript: parsed.scripts?.['build'],
        cleanScript: parsed.scripts?.['clean'],
      });
    }
  }
  return out;
}

describe('incremental build artifacts are managed with dist/', () => {
  const packages = readWorkspacePackages();

  /**
   * Guards against a regex that stops matching turning "no violations" into
   * "no data" — the same second assertion `service-ports.test.ts` carries.
   */
  it('discovers the workspace', () => {
    expect(packages.length).toBeGreaterThan(40);
  });

  it("turbo's build task lists *.tsbuildinfo as an output", () => {
    const turbo = readFileSync(path.join(REPO_ROOT, 'turbo.json'), 'utf8');
    // Read as text: `turbo.json` carries `//` comments, so it is JSONC and
    // `JSON.parse` would throw. The property is a literal in the outputs array.
    expect(turbo).toContain('"*.tsbuildinfo"');
  });

  it('every tsc-built package cleans its .tsbuildinfo', () => {
    const offenders: string[] = [];

    for (const pkg of packages) {
      // Only packages whose build is `tsc` are affected — `next build` does not
      // consult a `.tsbuildinfo` to decide whether to emit.
      if (pkg.buildScript === undefined || !pkg.buildScript.includes('tsc -p')) continue;

      const clean = pkg.cleanScript;
      if (clean === undefined) {
        offenders.push(`${pkg.name}: builds with tsc but has no clean script`);
        continue;
      }
      const missing = TSBUILDINFO_NAMES.filter((name) => !clean.includes(name));
      if (missing.length > 0) {
        offenders.push(`${pkg.name}: clean does not remove ${missing.join(' / ')} — "${clean}"`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('finds a non-trivial number of tsc-built packages', () => {
    const tscBuilt = packages.filter((p) => p.buildScript?.includes('tsc -p') === true);
    // ~20 services + 9 workers + the gateway + ~20 packages. A collapse here
    // means the discovery walk broke, not that the repo shrank.
    expect(tscBuilt.length).toBeGreaterThan(40);
  });
});
