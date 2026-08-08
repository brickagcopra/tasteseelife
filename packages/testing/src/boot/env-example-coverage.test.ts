import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * `.env.example` is the documented environment a fresh clone boots from, and
 * it must stay in agreement with the Zod schemas that actually read it
 * (TS-504-followup-2).
 *
 * **Why this exists.** TS-504 filled the file in by hand and verified it by
 * executing every app's real `loadEnv()` against it. That one-off found three
 * defects on its first run — but it was a one-off, and nothing stopped the
 * file drifting the moment the next required var landed. The failure mode is
 * silent: everything stays green until someone clones the repo and the fleet
 * will not start, or worse, starts in the wrong mode.
 *
 * **Two directions, and both matter.**
 *
 * 1. *Forward* — every app's schema accepts the file. This is the acceptance
 *    criterion: add a required var without updating `.env.example` and this
 *    fails, naming the app and the key. It was already green when the guard
 *    landed (TS-504 left it that way), which is exactly when to nail it down.
 *
 * 2. *Reverse* — every assignment in the file is read by something. A key
 *    nobody consumes is not harmless documentation: it is a lever that looks
 *    connected and is not. The reverse direction found seven such keys on its
 *    first run, including `OPENSEARCH_NODE` — service-search reads
 *    `ELASTICSEARCH_NODE_URL`, and its absence forces stub mode, so a
 *    developer who set the documented variable got a silently stubbed search
 *    backend and no error anywhere.
 *
 * **Why it executes the schemas instead of diffing key names.** A name diff
 * cannot tell a required var from an optional one, cannot see a `.default()`,
 * and cannot catch a placeholder that parses as the wrong shape — the class of
 * defect TS-504 actually found (`MFA_TOTP_ENC_KEY` and `STRIPE_SECRET_KEY`
 * were present but invalid). Running the real `loadEnv` asks the only question
 * that matters: would this app boot from this file?
 *
 * **Why it imports from source rather than `dist/`.** The pending entry
 * proposed a script over each app's compiled `dist/config/env.js`, which would
 * have needed a `dependsOn: ["^build"]` turbo task of its own. Vitest
 * transpiles the TypeScript directly, so the guard joins the existing test
 * lane with no build dependency, no new turbo task, and — like every other
 * guard in this directory — it sees what a reviewer sees rather than a stale
 * artefact.
 *
 * **Ownership has exactly two sources, deliberately.** A key is owned if some
 * app's schema consumes it, or if `docker-compose.yml` interpolates it. Both
 * are derived by asking the consumer, so neither needs a hand-maintained list.
 * There is no exemption allow-list: a var that nothing reads yet belongs
 * commented out, which documents it just as well while making it impossible to
 * mistake for a live setting. That is the escape hatch, and it is a better one
 * than an allow-list because a commented key cannot mislead anyone.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');

/**
 * Every workspace that owns an env schema, and the file that declares it.
 *
 * Two shapes exist. Services and workers keep theirs at `src/config/env.ts`
 * and take an injectable source; the authenticated Next portals keep theirs at
 * `lib/env.ts` and read `process.env` directly (they never compile to `dist/`,
 * which is why the `dist/`-based approach would have had to skip them).
 * Importing from source covers both, so the portals are checked here for the
 * first time.
 */
function envSchemaModules(): readonly { readonly app: string; readonly file: string }[] {
  const out: { app: string; file: string }[] = [];
  const scopes = [
    { dir: APPS_DIR, label: '' },
    { dir: WORKERS_DIR, label: 'workers/' },
  ];
  for (const scope of scopes) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      for (const relative of ['src/config/env.ts', 'lib/env.ts']) {
        const file = path.join(scope.dir, entry.name, relative);
        try {
          readFileSync(file, 'utf8');
        } catch {
          // Not every workspace under `apps/` owns an env schema
          // (web-marketing is entirely public and validates nothing).
          continue;
        }
        out.push({ app: `${scope.label}${entry.name}`, file });
      }
    }
  }
  return out;
}

interface EnvModule {
  readonly loadEnv: (source?: NodeJS.ProcessEnv) => Record<string, unknown>;
}

async function importEnvModule(file: string): Promise<EnvModule> {
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as EnvModule;
}

/**
 * Parse `.env.example` with **the E2E fleet's own parser**, imported by path
 * rather than reimplemented.
 *
 * `apps/e2e/src/repo-env.ts` already parses this file, because the fleet boots
 * from it. A second parser here would be a copy that can disagree — and if the
 * two ever diverged, this guard would be checking a file that the fleet reads
 * differently, which is the one outcome that would make a green run
 * meaningless. `@taste-and-see/testing` cannot take a dependency on an app, so
 * the module is loaded the same way the schemas are.
 */
async function parsedEnvExample(): Promise<Record<string, string>> {
  const module = (await import(
    /* @vite-ignore */ pathToFileURL(path.join(APPS_DIR, 'e2e/src/repo-env.ts')).href
  )) as { loadRepoEnvExample: () => Record<string, string> };
  return module.loadRepoEnvExample();
}

/** Keys `docker-compose.yml` interpolates — `${POSTGRES_USER:-tastesee}`. */
function composeReferencedKeys(): ReadonlySet<string> {
  const source = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const keys = new Set<string>();
  for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
    const key = match[1];
    if (key !== undefined) keys.add(key);
  }
  return keys;
}

/**
 * Run one app's `loadEnv` against the parsed file.
 *
 * The portals ignore the argument and read `process.env`, so it is swapped for
 * the duration of the call and restored in `finally` — a leaked swap would
 * corrupt every later test in the file.
 */
function runLoadEnv(
  module: EnvModule,
  source: Record<string, string>,
): { ok: true; consumed: readonly string[] } | { ok: false; message: string } {
  const original = process.env;
  try {
    process.env = source as NodeJS.ProcessEnv;
    return { ok: true, consumed: Object.keys(module.loadEnv(source)) };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    process.env = original;
  }
}

describe('.env.example agrees with the env schemas that read it', () => {
  const modules = envSchemaModules();

  it('discovers every app that owns an env schema', () => {
    // The "did the walk break?" assertion every guard in this directory
    // carries. A directory scan that silently stopped matching would turn
    // this into a green no-op, which is worse than no check at all. There
    // were 33 at the time of writing (30 services + workers, 3 portals);
    // the floor allows growth and catches collapse.
    expect(modules.length).toBeGreaterThanOrEqual(30);
  });

  it('is accepted by every app that reads it', async () => {
    const source = await parsedEnvExample();
    const rejections: string[] = [];

    for (const { app, file } of modules) {
      const result = runLoadEnv(await importEnvModule(file), source);
      if (!result.ok) {
        rejections.push(
          `${app} rejects .env.example — ${result.message}. Add the key to .env.example ` +
            `with a development placeholder that satisfies its own validation, or give the ` +
            `schema a default if the value is genuinely optional.`,
        );
      }
    }

    expect(rejections).toEqual([]);
  });

  it('sets nothing that no app and no container reads', async () => {
    const source = await parsedEnvExample();
    const consumed = new Set<string>(composeReferencedKeys());
    const rejecting: string[] = [];

    for (const { app, file } of modules) {
      const result = runLoadEnv(await importEnvModule(file), source);
      if (result.ok) for (const key of result.consumed) consumed.add(key);
      else rejecting.push(app);
    }

    // A rejecting app contributes no keys, so every var only it declares would
    // read as an orphan here. That list would be an artefact of the previous
    // test's failure, not a finding — so say so instead of printing it, and
    // keep one cause to one failure.
    expect(
      rejecting,
      `Ownership cannot be evaluated while ${rejecting.join(', ')} reject(s) .env.example — ` +
        `fix the preceding failure first; this check has not run.`,
    ).toEqual([]);

    const orphans = Object.keys(source).filter((key) => !consumed.has(key));

    expect(orphans, orphanMessage(orphans)).toEqual([]);
  });
});

function orphanMessage(orphans: readonly string[]): string {
  return (
    `.env.example assigns ${orphans.length} key(s) that no env schema declares and ` +
    `docker-compose.yml does not interpolate: ${orphans.join(', ')}. A key nobody reads ` +
    `looks like a working setting and is not — that is how OPENSEARCH_NODE left ` +
    `service-search stubbed. Either wire it up (check the spelling against the schema — ` +
    `service-search reads ELASTICSEARCH_NODE_URL), or comment the line out so it still ` +
    `documents the variable without pretending to configure anything.`
  );
}
