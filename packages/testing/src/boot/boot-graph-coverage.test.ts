import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every Nest app and worker must carry a boot-graph guard, and must expose
 * it on the dedicated lane (TS-506-followup-2).
 *
 * **Why a guard over a guard.** TS-506 landed 30 `test/app-module-graph.test.ts`
 * files because 8 of 20 services had shipped unable to start. TS-506-followup-2
 * then gave those suites their own turbo task and CI job so a boot-graph break
 * reads as "this service cannot start" rather than "service-X unit tests
 * failed". Both of those are per-app facts — a new service is added by copying
 * a directory, and the copy that forgets the file or the script joins the fleet
 * with no boot-graph coverage and nothing red. The CI job would keep passing,
 * having quietly stopped covering it.
 *
 * That is the failure mode the platform has already been bitten by more than
 * once: `apps/workers/*` was missed by three separate sweeps before
 * TS-505-followup-4 (see `service-ports.test.ts`), so this file sweeps BOTH
 * scopes from the start rather than defaulting to `apps/*` and being corrected
 * later.
 *
 * **The trigger is `src/app.module.ts`.** That file is what makes a workspace a
 * Nest application with a graph to resolve; the three Next portals and the
 * library packages have none and are correctly out of scope. Deriving the list
 * this way rather than hard-coding 30 names is the point — a hard-coded list
 * has the same drift problem as the thing it is guarding.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');

const BOOT_GRAPH_SCRIPT = 'test:boot-graph';
const BOOT_GRAPH_TEST_PATH = path.join('test', 'app-module-graph.test.ts');

interface NestApp {
  readonly label: string;
  readonly dir: string;
}

function nestApps(): readonly NestApp[] {
  const out: NestApp[] = [];
  const scopes: readonly { dir: string; prefix: string }[] = [
    { dir: APPS_DIR, prefix: '' },
    { dir: WORKERS_DIR, prefix: 'workers/' },
  ];

  for (const scope of scopes) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      const dir = path.join(scope.dir, entry.name);
      // The discriminator: a Nest app is a workspace with an AppModule.
      if (!existsSync(path.join(dir, 'src', 'app.module.ts'))) continue;
      out.push({ label: `${scope.prefix}${entry.name}`, dir });
    }
  }
  return out;
}

function packageScripts(dir: string): Record<string, string> {
  const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return scripts as Record<string, string>;
}

describe('boot-graph coverage', () => {
  it('finds every Nest app and worker', () => {
    // A floor, not an equality: adding a service should not have to touch
    // this file. It exists so a scope that stops finding anything (a moved
    // directory, a renamed AppModule) fails loudly instead of passing
    // vacuously over an empty list.
    const apps = nestApps();
    expect(apps.length).toBeGreaterThanOrEqual(30);
    expect(apps.filter((a) => a.label.startsWith('workers/')).length).toBeGreaterThanOrEqual(9);
  });

  it('every Nest app has a boot-graph suite', () => {
    const missing = nestApps()
      .filter((app) => !existsSync(path.join(app.dir, BOOT_GRAPH_TEST_PATH)))
      .map((app) => app.label);

    expect(
      missing,
      `these apps have a src/app.module.ts but no ${BOOT_GRAPH_TEST_PATH} — nothing proves they can start: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every Nest app exposes the boot-graph suite on its own lane', () => {
    // Without the script, `turbo run test:boot-graph` simply skips the
    // package: the CI job stays green while covering one app fewer. Silent
    // shrinkage is the whole risk here.
    const missing = nestApps()
      .filter((app) => packageScripts(app.dir)[BOOT_GRAPH_SCRIPT] === undefined)
      .map((app) => app.label);

    expect(
      missing,
      `these apps have a boot-graph suite but no "${BOOT_GRAPH_SCRIPT}" script, so the dedicated CI job does not run it: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the boot-graph script targets the boot-graph suite and nothing else', () => {
    // A `test:boot-graph` that ran the whole suite would make the dedicated
    // job a duplicate of the unit lane — slower, and no more legible.
    const wrong = nestApps()
      .filter((app) => {
        const script = packageScripts(app.dir)[BOOT_GRAPH_SCRIPT];
        return script !== undefined && !script.includes('test/app-module-graph.test.ts');
      })
      .map((app) => app.label);

    expect(wrong).toEqual([]);
  });
});
