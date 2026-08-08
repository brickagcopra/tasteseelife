import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Every env var a workload's schema REQUIRES must be supplied by its k8s
 * ConfigMap or Secret (TS-504-followup-2b).
 *
 * **Why this exists.** `env-example-coverage.test.ts` keeps `.env.example` and
 * the Zod schemas in agreement. The same drift exists one layer over, and until
 * now nothing checked it: a required var absent from a workload's manifests
 * means the pod fails Zod validation at boot and CrashLoops on rollout — a
 * defect that is invisible locally, invisible in CI, and only shows up in a
 * deploy. It has happened: TS-309b1 found neither of service-identity's
 * internal secrets present in its Secret placeholder.
 *
 * **How "required" is determined.** Not by reading the schema source and
 * guessing which `z.string()` lacks a `.default()` — by *asking the schema*.
 * Calling `loadEnv({})` fails with a message naming every key it could not
 * supply (`DATABASE_URL: Required; JWT_ACCESS_SECRET: Required; …`). That is
 * the exact required set, derived from the same code path the pod runs, and it
 * stays correct through `.default()`, `.optional()`, `superRefine` wrappers and
 * anything else a schema grows.
 *
 * **The reverse direction** — a key set in a manifest that nothing reads — is
 * the second half, added by TS-504-followup-2b1. It is the TS-306-followup-1c
 * defect: trust-safety's ConfigMap set `OTEL_*_ENABLED` keys that `loadEnv`'s
 * key-pick silently dropped, so the ConfigMap had been lying since
 * TS-300-followup-2. A key that configures nothing while looking like
 * configuration is worse than an absent one, because the next operator to
 * change behaviour will change it and nothing will happen.
 *
 * TS-504-followup-2b measured that direction and did not ship it, because
 * approximating the *declared* set as "what `loadEnv` returns, plus what it
 * requires" produced false positives for every declared-but-`.optional()` key
 * (`STRIPE_API_VERSION`, `SCAN_EVENT_INGEST_*`). The fix is not an exemption
 * list — it is to **ask each consumer**, the same move
 * `env-example-coverage.test.ts` makes with `docker-compose.yml`. A workload
 * has three of them, and all three are derived rather than enumerated:
 *
 *   1. the **Zod schema**, by text-scanning `KEY: z` — presence only, since
 *      "required" already comes from the behavioural probe above and a
 *      `.optional()` key is still declared;
 *   2. **direct `process.env` reads** in the workspace's own source, which is
 *      how web-marketing reads every value it has (it owns no schema at all,
 *      and was invisible to this file until now);
 *   3. the **Node/Next runtime**, for the portals — `NODE_ENV`, `PORT` and
 *      `NEXT_TELEMETRY_DISABLED` are read by `next start` itself. It is a real
 *      consumer that simply has no source in this repo to scan, so it is
 *      declared as a consumer, once, and applied only to workloads that
 *      actually run Next.
 *
 * The distinction that keeps (3) from being an exemption list: it is scoped to
 * the portals, so a *service* ConfigMap setting `NEXT_TELEMETRY_DISABLED` still
 * fails. An allow-list would have excused it everywhere.
 *
 * **Why a text scan of the manifests.** Rendering an overlay needs
 * `kubectl kustomize --enable-helm`, which is CI-only on this machine
 * (TS-300-followup-2). The ConfigMap and Secret literals are syntactic facts in
 * the base, and no overlay adds env keys — overlays patch image tags, replica
 * counts and a handful of values. This also means the check sees what a
 * reviewer sees.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const K8S_SERVICES_DIR = path.join(REPO_ROOT, 'infra/kubernetes/services');

interface Workload {
  readonly name: string;
  readonly appDir: string;
  /** `null` for a workload that owns no Zod schema — web-marketing today. */
  readonly envSchemaFile: string | null;
  readonly manifestDir: string;
  /** Runs under `next start`, so the Next runtime is one of its env consumers. */
  readonly isPortal: boolean;
}

/**
 * Pair each k8s base with the workspace it configures.
 *
 * `infra/kubernetes/services/worker-foo` is `apps/workers/foo`; everything else
 * is `apps/<name>`.
 *
 * A base whose workspace owns no env schema is **kept, with a null schema**,
 * not skipped. Skipping is what hid web-marketing: it validates nothing, reads
 * `process.env` directly, and so was absent from this file entirely — the one
 * workload where a manifest key has no schema to disagree with was the one
 * nothing checked.
 */
function workloads(): readonly Workload[] {
  const out: Workload[] = [];
  for (const entry of readdirSync(K8S_SERVICES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const appDir = entry.name.startsWith('worker-')
      ? path.join(REPO_ROOT, 'apps/workers', entry.name.slice('worker-'.length))
      : path.join(REPO_ROOT, 'apps', entry.name);
    if (!existsSync(appDir)) continue;

    const envSchemaFile =
      ['src/config/env.ts', 'lib/env.ts']
        .map((relative) => path.join(appDir, relative))
        .find((candidate) => existsSync(candidate)) ?? null;

    out.push({
      name: entry.name,
      appDir,
      envSchemaFile,
      manifestDir: path.join(K8S_SERVICES_DIR, entry.name),
      // The discriminator is the Next config, not the `web-` prefix: a portal
      // is a workload `next start` runs, and that is the fact the runtime-keys
      // consumer turns on.
      isPortal: ['next.config.ts', 'next.config.mjs', 'next.config.js'].some((name) =>
        existsSync(path.join(appDir, name)),
      ),
    });
  }
  return out;
}

/**
 * The keys a schema cannot supply for itself.
 *
 * `process.env` is swapped to `{}` as well as passing `{}`: the three portal
 * schemas ignore the argument and read `process.env` directly, so without the
 * swap they would validate against the developer's real environment.
 */
async function requiredKeys(envSchemaFile: string): Promise<readonly string[]> {
  const module = (await import(/* @vite-ignore */ pathToFileURL(envSchemaFile).href)) as {
    loadEnv: (source?: NodeJS.ProcessEnv) => unknown;
  };
  const original = process.env;
  try {
    process.env = {} as NodeJS.ProcessEnv;
    module.loadEnv({});
    return [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [
      ...new Set([...message.matchAll(/([A-Z][A-Z0-9_]*): Required/g)].map((m) => m[1])),
    ].filter((key): key is string => key !== undefined);
  } finally {
    process.env = original;
  }
}

/**
 * Collect the keys declared directly under a YAML block header.
 *
 * Scoped to the block rather than scanning the whole file: a bare
 * `/^\s+[A-Z_]+:/` sweep would also pick up unrelated uppercase YAML and could
 * only ever make this check *more* permissive — a required key would appear
 * "present" because some other part of the manifest mentioned it.
 */
function keysUnderBlock(source: string, header: RegExp): readonly string[] {
  const lines = source.split(/\r?\n/);
  const keys: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined || !header.test(line)) continue;
    const headerIndent = line.length - line.trimStart().length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j];
      if (candidate === undefined) break;
      if (candidate.trim() === '' || candidate.trimStart().startsWith('#')) continue;
      const indent = candidate.length - candidate.trimStart().length;
      if (indent <= headerIndent) break;
      const match = /^([A-Z][A-Z0-9_]*):/.exec(candidate.trim());
      if (indent === headerIndent + 2 && match?.[1] !== undefined) keys.push(match[1]);
    }
  }
  return keys;
}

/**
 * Consumer 1 — the keys a Zod env schema *declares*, by text scan.
 *
 * Presence only, deliberately. "Required" already comes from the behavioural
 * probe above and does not need to be re-derived from source; what the probe
 * cannot give is the declared-but-optional key, which is exactly where
 * TS-504-followup-2b's approximation produced its false positives. A text scan
 * cannot tell the two apart either — and does not have to, because a declared
 * key is a read key whether or not it has a default.
 *
 * It reads the body of each `z.object({…})` rather than matching `KEY: z`.
 * The narrower pattern was tried first and was **wrong**: the two composed
 * workers declare through shared helpers — `NOTIFICATION_DISPATCH_API_KEY:
 * SharedSecretSchema('…')`, `…_HEADER_NAME: NonEmptySchema.default('…')` — so
 * it saw neither, and reported seven live secrets as dead manifest keys.
 *
 * Soundness is asserted rather than assumed (see the test below): every key the
 * behavioural probe reports as *required* must be one this scan found. That is
 * what caught the `KEY: z` version, before its output could be believed.
 */
function schemaDeclaredKeys(envSchemaFile: string | null): ReadonlySet<string> {
  if (envSchemaFile === null) return new Set();
  const source = readFileSync(envSchemaFile, 'utf8');
  const keys = new Set<string>();
  for (const body of objectLiteralBodies(source)) {
    for (const match of body.matchAll(/^\s+([A-Z][A-Z0-9_]*):/gm)) {
      const key = match[1];
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

/**
 * The source text inside every `z.object({ … })`, by brace matching.
 *
 * Every `.object(` is read, not just the first: a schema assembled by `.merge`
 * or `.extend` declares in more than one. A comment line cannot contribute a
 * key — `// KEY:` and ` * KEY:` both fail the `^\s+KEY:` anchor — and the
 * literals in these files contain no braces, which is what makes plain
 * counting sufficient.
 */
function objectLiteralBodies(source: string): readonly string[] {
  const bodies: string[] = [];
  for (const match of source.matchAll(/\.object\(\s*\{/g)) {
    let depth = 1;
    const start = match.index + match[0].length;
    let i = start;
    for (; i < source.length && depth > 0; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
    }
    bodies.push(source.slice(start, i));
  }
  return bodies;
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.mjs', '.js'];
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'coverage',
  'generated',
  'prisma',
]);

/**
 * Consumer 2 — keys the workspace reads straight off `process.env`.
 *
 * A schema is the normal way to read config here, but it is not the only one:
 * web-marketing owns no schema and reads `process.env['API_GATEWAY_BASE_URL']`
 * directly. Asking the source is what lets that workload be checked at all
 * instead of exempted.
 *
 * Test files are excluded. A key that appears only in a `.test.ts` is being
 * *set* by a fixture, not read by the app — web-marketing's `blog.test.ts`
 * assigns `API_GATEWAY_BASE_URL` to exercise `blog.ts`, and counting that as a
 * consumer would let a manifest key stay alive on the strength of a test that
 * mentions it.
 */
function directEnvReads(dir: string, into: Set<string> = new Set()): ReadonlySet<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
      directEnvReads(path.join(dir, entry.name), into);
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;

    const source = readFileSync(path.join(dir, entry.name), 'utf8');
    for (const match of source.matchAll(
      /process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|process\.env\.([A-Z][A-Z0-9_]*)/g,
    )) {
      const key = match[1] ?? match[2];
      if (key !== undefined) into.add(key);
    }
  }
  return into;
}

/**
 * Consumer 3 — the Node/Next runtime.
 *
 * These are read by `next start` and the Next CLI, not by any code in this
 * repo, so there is nothing to scan and they have to be named. What stops that
 * from being an exemption list is the scoping: it applies only to workloads
 * that actually run Next, so a *service* ConfigMap setting
 * `NEXT_TELEMETRY_DISABLED` is still a finding.
 *
 * `LOG_LEVEL` is deliberately NOT here. The portals set it in their ConfigMaps
 * and nothing reads it — no schema declares it, no source reads it, and Next
 * has no such setting. It is a copy of the service ConfigMap template, and it
 * is precisely the kind of lie this direction exists to find.
 */
const NEXT_RUNTIME_KEYS: ReadonlySet<string> = new Set([
  'NODE_ENV',
  'PORT',
  'NEXT_TELEMETRY_DISABLED',
]);

/** Every env key a workload's base supplies, from its ConfigMap and its Secret. */
function suppliedKeys(manifestDir: string): ReadonlySet<string> {
  const keys = new Set<string>();
  const kustomization = path.join(manifestDir, 'kustomization.yaml');
  if (existsSync(kustomization)) {
    const source = readFileSync(kustomization, 'utf8');
    // The ConfigMap patch replaces `/data` wholesale — the keys sit under the
    // `value:` that follows.
    for (const key of keysUnderBlock(source, /^\s*value:\s*$/)) keys.add(key);
  }
  for (const file of readdirSync(manifestDir)) {
    if (!file.endsWith('.yaml')) continue;
    const source = readFileSync(path.join(manifestDir, file), 'utf8');
    for (const key of keysUnderBlock(source, /^\s*stringData:\s*$/)) keys.add(key);
  }
  return keys;
}

describe('every k8s workload supplies the env its schema requires', () => {
  const discovered = workloads();

  it('pairs each k8s base with the schema it configures', () => {
    // The "did the walk break?" assertion every guard in this directory
    // carries. If the pairing silently stopped resolving, the check below
    // would pass over an empty list. There were 33 at the time of writing.
    expect(discovered.length).toBeGreaterThanOrEqual(30);
  });

  it('supplies every required key from a ConfigMap or a Secret', async () => {
    const gaps: string[] = [];

    for (const workload of discovered) {
      if (workload.envSchemaFile === null) continue;
      const required = await requiredKeys(workload.envSchemaFile);
      const supplied = suppliedKeys(workload.manifestDir);
      const missing = required.filter((key) => !supplied.has(key));
      if (missing.length > 0) {
        gaps.push(
          `${workload.name} requires ${missing.join(', ')} but its k8s base supplies neither a ` +
            `ConfigMap nor a Secret entry for them — the pod fails Zod validation at boot and ` +
            `CrashLoops on rollout. Add non-secret values to the ConfigMap patch in ` +
            `kustomization.yaml and secrets to secret-placeholder.yaml.`,
        );
      }
    }

    expect(gaps).toEqual([]);
  });

  it('finds required keys to check, so the assertion is not vacuous', async () => {
    // If `loadEnv({})` ever stopped throwing — or its message stopped naming
    // keys — every workload would report an empty required set and the check
    // above would pass while checking nothing.
    const identity = discovered.find((w) => w.name === 'service-identity');
    expect(identity).toBeDefined();
    const required = await requiredKeys(identity?.envSchemaFile ?? '');
    expect(required).toContain('DATABASE_URL');
    expect(required.length).toBeGreaterThan(5);
  });

  it('reads the declared set soundly enough to judge the reverse direction', async () => {
    // The reverse check below calls a key an orphan when no consumer claims it,
    // so a text scan that missed a declaration would report real config as
    // dead. Every key the behavioural probe says is required must be one the
    // scan found; anything else means the scan needs widening, and this names
    // it rather than letting it surface as a manifest "orphan".
    const blind: string[] = [];

    for (const workload of discovered) {
      if (workload.envSchemaFile === null) continue;
      const declared = schemaDeclaredKeys(workload.envSchemaFile);
      const unseen = (await requiredKeys(workload.envSchemaFile)).filter(
        (key) => !declared.has(key),
      );
      if (unseen.length > 0) blind.push(`${workload.name}: ${unseen.join(', ')}`);
    }

    expect(
      blind,
      `the \`KEY: z\` scan did not find these required keys in their own schema: ` +
        `${blind.join(' | ')}. The declared set is now under-read, which makes the ` +
        `reverse check report live configuration as dead — widen the scan before ` +
        `trusting it.`,
    ).toEqual([]);
  });

  it('sets nothing in a ConfigMap or Secret that no consumer reads', () => {
    const orphans: string[] = [];

    for (const workload of discovered) {
      const consumed = new Set<string>([
        ...schemaDeclaredKeys(workload.envSchemaFile),
        ...directEnvReads(workload.appDir),
        ...(workload.isPortal ? NEXT_RUNTIME_KEYS : []),
      ]);

      const stale = [...suppliedKeys(workload.manifestDir)].filter((key) => !consumed.has(key));
      if (stale.length > 0) orphans.push(`${workload.name}: ${stale.join(', ')}`);
    }

    expect(
      orphans,
      `these k8s bases set env keys no consumer reads — no schema declares them, no source ` +
        `reads them off process.env, and they are not Next runtime settings: ` +
        `${orphans.join(' | ')}. \`loadEnv\` drops undeclared keys before validating (TS-153), ` +
        `so the value is silently discarded while the manifest still reads as configuration — ` +
        `the next operator to change behaviour will change this and nothing will happen ` +
        `(TS-306-followup-1c). Delete the key, or wire it up if it was meant to do something.`,
    ).toEqual([]);
  });
});
