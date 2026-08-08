import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ENV_SCHEMA_PATH,
  importEnvModule,
  nestApps,
  parseStubEnv,
  requiredKeys,
  runLoadEnv,
  type NestApp,
} from './env-contract';

/**
 * Each `test/integration/**` suite sets its app's environment with a block of
 * `process.env.X = …` assignments, and that block must stay in agreement with
 * the schema that reads it (TS-506-followup-3b).
 *
 * **This is the third copy of every app's env contract, and it was the
 * uncovered one.** `.env.example` is guarded by `env-example-coverage.test.ts`
 * (TS-504-followup-2); the boot-graph `STUB_ENV` records are guarded by
 * `boot-graph-stub-env.test.ts` (TS-506-followup-3); these blocks were guarded
 * by nothing.
 *
 * **It bites harder than the other two, because the integration lane is not
 * part of `turbo run test`.** A stale `STUB_ENV` breaks the fast lane on the
 * next commit. A stale integration fixture produces *no signal at all* until
 * somebody runs `pnpm -F <app> test:integration` by hand — and on this platform
 * that can be a long time, because the lane needs Docker. service-provider's
 * fixture was two required keys behind and had been dying inside `loadEnv`,
 * before its first assertion, for an unknown stretch (TS-305d-followup-2a); the
 * suite that then ran surfaced a second latent defect immediately
 * (TS-305d-followup-2b). Rot first, findings second.
 *
 * **Keys, not values.** The other two guards execute the schema against the
 * fixture's actual values, and that is the stronger check. It is not available
 * here: these values are generated per run (`randomBytes(32).toString('hex')`,
 * `` `chk_test_${…}` ``) or come from a container that has not started yet
 * (`stack.databaseUrl`, `inject('redisUrl')`). Generating them per run is
 * correct — CLAUDE.md §17.12 forbids committing secrets, and every one of these
 * clears a `min(32)` floor that a placeholder would not. So this guard asks the
 * question that can be answered from the source and that the drift actually
 * turns on: **is every key the schema will not boot without assigned
 * somewhere in this app's integration fixtures?** `requiredKeys` gets that set
 * by running the app's own `loadEnv` against an empty environment and reading
 * the rejection, so a key with a `.default()` or an `.optional()` is correctly
 * never demanded.
 *
 * **The parse is asserted total**, exactly as `boot-graph-stub-env.test.ts`
 * asserts its own. A parser that silently skipped an assignment it could not
 * read would shrink the set it then checks and pass while covering almost
 * nothing — and unlike an object literal, these blocks are statements, so the
 * ways to write one are open-ended. Every `process.env.` occurrence in an
 * integration suite must be accounted for as either an assignment this file
 * understood or a read.
 *
 * **Per file, not per app.** Several apps have more than one integration suite
 * (service-identity has six) and they do not set identical blocks —
 * `ip-circuit-breaker` tunes the rate limiter, `mfa` tunes TOTP. Each file has
 * to satisfy the schema on its own, so a union across an app's suites would let
 * one file's completeness hide another file's gap.
 *
 * **Scope: a suite that assigns at least one key.** Two suites configure their
 * app some other way and are deliberately outside this check —
 * `workers/identity-janitor` passes an explicit object literal to `loadEnv({…})`
 * (the better pattern: no ambient mutation, and the call site is type-checked),
 * and `service-identity/wiring` sets nothing because it never boots the
 * AppModule. Neither can drift the way this guard exists to catch: **the failure
 * mode is a *partial* block**, a fixture that satisfied the schema when it was
 * written and no longer does. A suite with no block at all fails loudly on its
 * very first run instead of dying halfway. Requiring one assignment before
 * demanding the rest is what keeps this guard from insisting every suite adopt
 * a pattern it does not use.
 *
 * **What it found on the first run**: fifteen of the seventeen suites were
 * behind, every one of them on `INTERNAL_TRUST_SIGNING_SECRET`, and four
 * service-household suites additionally on
 * `HOUSEHOLD_MEMBERSHIPS_INTERNAL_API_KEY`. Confirmed rather than assumed —
 * `pnpm -F @taste-and-see/service-search test:integration` reported
 * `EnvValidationError: INTERNAL_TRUST_SIGNING_SECRET: Required` with all 17 of
 * its tests uncollected.
 */

/** `process.env.KEY = …` — an assignment, which `=` distinguishes from a read. */
const ASSIGNMENT = /process\.env\.([A-Za-z_][A-Za-z0-9_]*)\s*=[^=]/g;
/** Every mention, assignment or not. The totality check counts against this. */
const ANY_MENTION = /process\.env\b/g;
/** `${process.env.X}` and `process.env.X` in an expression: a read, not a write. */
const BRACKET_ACCESS = /process\.env\[/g;

interface IntegrationSuite {
  readonly app: NestApp;
  /** Repo-relative, POSIX separators — this string lands in failure messages. */
  readonly label: string;
  readonly file: string;
}

function integrationSuites(): readonly IntegrationSuite[] {
  const out: IntegrationSuite[] = [];
  for (const app of nestApps()) {
    const dir = path.join(app.dir, 'test', 'integration');
    if (!existsSync(dir)) continue;
    const walk = (current: string): void => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.test.ts')) continue;
        out.push({
          app,
          label: `${app.label}/${path.relative(app.dir, full).replace(/\\/g, '/')}`,
          file: full,
        });
      }
    };
    walk(dir);
  }
  return out;
}

interface ParsedFixture {
  readonly assigned: readonly string[];
  /** Occurrences the parser could not classify as an assignment or a read. */
  readonly unaccounted: number;
}

function parseFixture(file: string): ParsedFixture {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const assigned = [...source.matchAll(ASSIGNMENT)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
  const mentions = [...source.matchAll(ANY_MENTION)].length;
  const brackets = [...source.matchAll(BRACKET_ACCESS)].length;
  // A read is any mention that is not an assignment we parsed. Bracket access
  // is called out separately because it is the one shape that WOULD be an
  // assignment and that this parser cannot read — if one ever appears, the
  // count below stops balancing and this guard says so rather than quietly
  // dropping the key.
  const reads = mentions - assigned.length - brackets;
  return { assigned: [...new Set(assigned)], unaccounted: brackets + (reads < 0 ? -reads : 0) };
}

describe('integration fixtures agree with the schemas that read them (TS-506-followup-3b)', () => {
  const allSuites = integrationSuites();
  /** See "Scope" in the file doc-block: one assignment is the entry condition. */
  const suites = allSuites.filter((suite) => parseFixture(suite.file).assigned.length > 0);

  it('finds the integration suites to check', () => {
    // Floors, not equalities: adding a suite must not have to touch this file.
    // They exist so a walk that stopped matching fails instead of passing
    // vacuously over an empty list — the same posture as every other guard in
    // this directory.
    expect(allSuites.length).toBeGreaterThanOrEqual(15);
    expect(suites.length).toBeGreaterThanOrEqual(13);
    expect(new Set(suites.map((suite) => suite.app.label)).size).toBeGreaterThanOrEqual(6);
  });

  it('accounts for every `process.env` occurrence it reads', () => {
    // Over ALL suites, not just the in-scope ones: an unreadable assignment is
    // how a suite would wrongly appear to have none at all.
    // The safety property the rest of this file rests on. `process.env['X'] = …`
    // is a legal assignment this parser does not understand, and a fixture that
    // used it would silently drop that key from the set checked below.
    const problems = allSuites
      .map((suite) => ({ suite, parsed: parseFixture(suite.file) }))
      .filter(({ parsed }) => parsed.unaccounted > 0)
      .map(
        ({ suite, parsed }) =>
          `${suite.label}: ${parsed.unaccounted} \`process.env\` occurrence(s) this parser ` +
          `cannot classify (bracket access, or a shape it does not read). Use ` +
          `\`process.env.KEY = …\` so the key stays covered.`,
      );
    expect(problems).toEqual([]);
  });

  it('assigns every key its app will not boot without', async () => {
    const gaps: string[] = [];

    for (const suite of suites) {
      const module = await importEnvModule(suite.app.envFile);
      const required = requiredKeys(module);
      const assigned = new Set(parseFixture(suite.file).assigned);
      const missing = required.filter((key) => !assigned.has(key));
      if (missing.length > 0) {
        gaps.push(
          `${suite.label}: does not set ${missing.join(', ')}, which ` +
            `${suite.app.label}/${ENV_SCHEMA_PATH} requires. The suite dies inside \`loadEnv\` ` +
            `before its first assertion, and because the integration lane is not in ` +
            `\`turbo run test\` nothing says so until someone runs it by hand.`,
        );
      }
    }

    expect(gaps).toEqual([]);
  }, 60_000);

  it('sets nothing its app does not declare', async () => {
    const orphans: string[] = [];

    for (const suite of suites) {
      const module = await importEnvModule(suite.app.envFile);
      const stub = parseStubEnv(suite.app.fixtureFile);
      // Declared keys come from a successful parse, and the only environment
      // known to satisfy every app's schema is the boot-graph `STUB_ENV` — which
      // its own guard proves valid. If that guard is red this one has nothing
      // sound to compare against, so it stands down rather than reporting an
      // artefact of the other failure.
      if (stub === null) continue;
      const result = runLoadEnv(module, stub.entries);
      if (!result.ok) continue;

      const declared = new Set(result.declared);
      const stale = parseFixture(suite.file).assigned.filter((key) => !declared.has(key));
      if (stale.length > 0) {
        orphans.push(`${suite.label}: ${stale.join(', ')}`);
      }
    }

    expect(
      orphans,
      "these integration fixtures set keys their app's schema does not declare: " +
        `${orphans.join(' | ')}. \`loadEnv\` drops undeclared keys before validating (TS-153), ` +
        'so the assignment configures nothing while still reading as a setting the suite ' +
        'needs — which is how a renamed env var leaves a fixture that looks complete. ' +
        'Delete it, or fix the spelling against the schema.',
    ).toEqual([]);
  }, 60_000);
});
