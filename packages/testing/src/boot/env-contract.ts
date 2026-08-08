import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Shared machinery for the guards that check an app's env contract against a
 * copy of it (TS-506-followup-3b).
 *
 * Each app's env contract exists in at least four places: the schema in
 * `src/config/env.ts` (the truth), `.env.example`, the boot-graph suite's
 * `STUB_ENV`, and — for the eight apps that own one — the `process.env.X = …`
 * block in each `test/integration/**` suite. Three guards now check copies
 * against the truth, and they were converging on the same four operations:
 * find the Nest apps, import a `loadEnv`, run it against a candidate
 * environment without leaking `process.env`, and turn the resulting
 * `EnvValidationError` into key names. Extracted here at the third copy rather
 * than the second, per CLAUDE.md's own rule-of-three posture.
 *
 * **What is deliberately NOT shared**: each guard's parser. The fixtures have
 * genuinely different shapes — an object literal, a dotenv file, a block of
 * assignment statements — and a parser widened to accept all three would be a
 * worse version of each. Only `parseStubEnv` lives here, because two files
 * need that exact one.
 */

export const REPO_ROOT = path.resolve(__dirname, '../../../..');
export const APPS_DIR = path.join(REPO_ROOT, 'apps');
export const WORKERS_DIR = path.join(APPS_DIR, 'workers');

/**
 * POSIX separators throughout: these strings appear in failure messages, and a
 * CI log that says `src\config\env.ts` on a Windows contributor's machine and
 * `src/config/env.ts` on the runner is one needless difference between the two
 * reports.
 */
export const BOOT_GRAPH_TEST_PATH = 'test/app-module-graph.test.ts';
export const ENV_SCHEMA_PATH = 'src/config/env.ts';

export interface NestApp {
  readonly label: string;
  /** The boot-graph suite carrying this app's `STUB_ENV`. */
  readonly fixtureFile: string;
  /** The `loadEnv` this app boots through. */
  readonly envFile: string;
  /** Absolute path to the app's workspace root. */
  readonly dir: string;
}

/**
 * Every Nest application in the repo, discriminated on `src/app.module.ts` —
 * the file that makes a workspace an app with a graph to resolve. The Next
 * portals and the library packages have none.
 *
 * An app missing the boot-graph suite or the env schema is skipped rather than
 * failed: `boot-graph-coverage` already owns "every Nest app has a suite", and
 * two guards reporting one omission makes the second one noise.
 */
export function nestApps(): readonly NestApp[] {
  const out: NestApp[] = [];
  const scopes: readonly { dir: string; prefix: string }[] = [
    { dir: APPS_DIR, prefix: '' },
    { dir: WORKERS_DIR, prefix: 'workers/' },
  ];

  for (const scope of scopes) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      const dir = path.join(scope.dir, entry.name);
      if (!existsSync(path.join(dir, 'src', 'app.module.ts'))) continue;

      const fixtureFile = path.join(dir, ...BOOT_GRAPH_TEST_PATH.split('/'));
      const envFile = path.join(dir, ...ENV_SCHEMA_PATH.split('/'));
      if (!existsSync(fixtureFile) || !existsSync(envFile)) continue;

      out.push({ label: `${scope.prefix}${entry.name}`, fixtureFile, envFile, dir });
    }
  }
  return out;
}

const STUB_ENV_BLOCK = /const STUB_ENV: Record<string, string> = \{\n([\s\S]*?)\n\};/;

/**
 * A key line: exactly two spaces of indentation inside the object literal. A
 * wrapped value sits at four, and a comment starts with `/` or `*`, so neither
 * can be mistaken for an entry.
 */
const KEY_LINE = /^ {2}([A-Z][A-Z0-9_]*):/gm;

/**
 * A complete entry, in either quote style, with the value optionally wrapped
 * onto the following line (Prettier does that once the key is long enough).
 * `[^\n]` keeps a value on one line, which is what makes `KEY_LINE` above a
 * sound count to check against.
 */
const ENTRY = /^ {2}([A-Z][A-Z0-9_]*):[ ]*(?:\n\s+)?(['"])((?:\\.|(?!\2)[^\n])*)\2,[ ]*$/gm;

export interface StubEnv {
  /** Every `KEY:` line found in the block, parsed or not. */
  readonly declaredKeys: readonly string[];
  /** The entries the parser understood in full. */
  readonly entries: Readonly<Record<string, string>>;
}

export function parseStubEnv(file: string): StubEnv | null {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const block = STUB_ENV_BLOCK.exec(source)?.[1];
  if (block === undefined) return null;

  const declaredKeys = [...block.matchAll(KEY_LINE)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

  const entries: Record<string, string> = {};
  for (const match of block.matchAll(ENTRY)) {
    const [, key, , value] = match;
    if (key !== undefined && value !== undefined) entries[key] = value;
  }

  return { declaredKeys, entries };
}

export interface EnvModule {
  readonly loadEnv: (source?: NodeJS.ProcessEnv) => Record<string, unknown>;
}

export async function importEnvModule(file: string): Promise<EnvModule> {
  return (await import(/* @vite-ignore */ pathToFileURL(file).href)) as EnvModule;
}

/**
 * Every app's `loadEnv` throws its own `EnvValidationError`, and there are 30
 * of those classes — one per app, all carrying the same `issues: ZodIssue[]`.
 * Reading the field rather than the class keeps these guards from importing 30
 * error types to `instanceof` against, and degrades to the message if some
 * future app throws something else.
 */
export function failedKeys(error: unknown): readonly string[] {
  if (typeof error !== 'object' || error === null || !('issues' in error)) return [];
  const { issues } = error as { issues?: unknown };
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) return [];
    const rawPath = (issue as { path?: unknown }).path;
    if (!Array.isArray(rawPath) || rawPath.length === 0) return [];
    const message = (issue as { message?: unknown }).message;
    return [`${rawPath.join('.')} (${typeof message === 'string' ? message : 'invalid'})`];
  });
}

/** Just the key names from a rejection, without the parenthesised reason. */
export function failedKeyNames(error: unknown): readonly string[] {
  return failedKeys(error).map((entry) => entry.replace(/ \(.*\)$/, ''));
}

export type LoadEnvResult =
  | { readonly ok: true; readonly declared: readonly string[] }
  | { readonly ok: false; readonly keys: readonly string[]; readonly message: string };

/**
 * The portals aside, `loadEnv` takes its source as an argument — but it
 * defaults to `process.env`, and a stray read of the ambient environment would
 * make a guard pass on a developer machine and fail in CI. Swapping it for the
 * fixture removes the difference; the swap is restored in `finally`, because a
 * leaked one would corrupt every later test in the file.
 */
export function runLoadEnv(module: EnvModule, source: Record<string, string>): LoadEnvResult {
  const original = process.env;
  try {
    process.env = source as NodeJS.ProcessEnv;
    return { ok: true, declared: Object.keys(module.loadEnv(source)) };
  } catch (error) {
    return {
      ok: false,
      keys: failedKeys(error),
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    process.env = original;
  }
}

/**
 * The keys an app's schema will not boot without: run its `loadEnv` against an
 * empty environment and read the rejection.
 *
 * This is what makes a keys-only check possible. Values in the integration
 * fixtures are generated per run (`randomBytes(32).toString('hex')`) or come
 * from a container that has not started yet (`stack.databaseUrl`), so they
 * cannot be read out of the source and validated — but "which keys must be
 * set" is exactly the question the schema answers on an empty input, and it is
 * the question the drift actually turns on.
 *
 * A key with a `.default()` or an `.optional()` never appears, which is
 * correct: a fixture that omits it still boots.
 */
export function requiredKeys(module: EnvModule): readonly string[] {
  const original = process.env;
  try {
    process.env = {} as NodeJS.ProcessEnv;
    module.loadEnv({});
    // A schema that accepts an empty environment requires nothing.
    return [];
  } catch (error) {
    return failedKeyNames(error);
  } finally {
    process.env = original;
  }
}
