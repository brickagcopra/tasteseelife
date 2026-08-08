import { describe, expect, it } from 'vitest';

import {
  BOOT_GRAPH_TEST_PATH,
  ENV_SCHEMA_PATH,
  importEnvModule,
  nestApps,
  parseStubEnv,
  runLoadEnv,
} from './env-contract';

/**
 * Each app's boot-graph suite carries a hand-written `STUB_ENV` record, and it
 * must stay in agreement with the schema that reads it (TS-506-followup-3).
 *
 * **Why this exists.** TS-506 landed 30 `test/app-module-graph.test.ts` files,
 * each with an explicit `STUB_ENV` generated from that app's `config/env.ts`.
 * Explicit is the right call — a fixture that re-derives itself at runtime
 * tests the derivation rather than the app — but it means each record is a
 * second copy of the env contract, and adding a required var breaks the
 * boot-graph suite with a raw `ZodError` thrown from an import three frames
 * deep. The suite says the service cannot start; it does not say the fixture is
 * one key short, and those two look identical from the CI log.
 *
 * This guard asks the same question in the one place where the answer can name
 * both halves: which app, and which key.
 *
 * **Why it executes the schema instead of diffing key names.** Copied
 * deliberately from `env-example-coverage.test.ts` (TS-504-followup-2), for the
 * same reason: a name diff cannot tell a required var from an optional one,
 * cannot see a `.default()`, and cannot catch a placeholder that is present but
 * invalid — which is a real failure mode here, because these values are stubs
 * written to satisfy validators nobody re-reads (`min length`, `base64`, `url`).
 * Running the real `loadEnv` asks the only question that matters: would this
 * app boot from this fixture?
 *
 * **Why it parses the fixture out of the test source.** The record lives inside
 * a `.test.ts` file, so it cannot be imported — importing it would register a
 * second suite's `describe` into this file's collection. The alternative was to
 * move all 30 records into sibling `test/stub-env.ts` modules, which is 30 more
 * files and moves the fixture away from the assertion it exists for.
 *
 * Parsing is only safe because **the parse is asserted total**: every `KEY:`
 * line inside the block must yield an entry, and a block the parser cannot read
 * in full fails loudly rather than contributing a shorter record. Silent
 * shrinkage is the failure mode a guard-over-a-guard exists to prevent (see
 * `boot-graph-coverage.test.ts`), and a lenient parser would reintroduce it
 * here — a fixture whose entries stopped matching would pass this file while
 * checking almost nothing.
 *
 * **Two directions, and both matter.**
 *
 * 1. *Forward* — the fixture satisfies the schema. This is the acceptance
 *    criterion: add a required env var to any app and this fails, naming the
 *    app and the key, before the boot-graph suite's `ZodError` does.
 *
 * 2. *Reverse* — every key the fixture sets is one the schema declares.
 *    `loadEnv` deliberately drops undeclared keys before validating (TS-153, so
 *    a pod's ambient env does not trip `.strict()`), which means a stub key
 *    left behind by a removed env var is invisible: it reads as "this service
 *    needs this" and configures nothing. Same shape as the orphan check on
 *    `.env.example`, and it exists for the same reason.
 */

/**
 * The discovery walk, the `STUB_ENV` parser, the `loadEnv` runner and the
 * error-to-key-names reader all moved to `./env-contract` when
 * TS-506-followup-3b became the third guard to need them. Their reasoning
 * moved with them; this file keeps only the assertions.
 */

describe('boot-graph STUB_ENV records agree with the schemas that read them', () => {
  const apps = nestApps();

  it('finds every Nest app that carries a boot-graph fixture', () => {
    // A floor, not an equality: adding a service should not have to touch this
    // file. It exists so a walk that stopped matching — a moved directory, a
    // renamed fixture — fails instead of passing vacuously over an empty list.
    expect(apps.length).toBeGreaterThanOrEqual(30);
    expect(apps.filter((app) => app.label.startsWith('workers/')).length).toBeGreaterThanOrEqual(9);
  });

  it('parses every STUB_ENV record in full', () => {
    // The safety property this whole guard rests on. Every check below is only
    // as good as the record it read, so a block the parser understands
    // partially must fail here rather than silently shrink the fixture it goes
    // on to validate.
    const problems: string[] = [];

    for (const app of apps) {
      const stub = parseStubEnv(app.fixtureFile);
      if (stub === null) {
        problems.push(
          `${app.label}: no \`const STUB_ENV: Record<string, string> = {…};\` found in ` +
            `${BOOT_GRAPH_TEST_PATH}. The declaration shape is load-bearing — this guard reads ` +
            `the fixture out of the source because a .test.ts cannot be imported.`,
        );
        continue;
      }
      if (stub.declaredKeys.length === 0) {
        problems.push(`${app.label}: STUB_ENV is empty, which no app's schema accepts.`);
        continue;
      }
      const unparsed = stub.declaredKeys.filter((key) => stub.entries[key] === undefined);
      if (unparsed.length > 0) {
        problems.push(
          `${app.label}: could not read ${unparsed.length} STUB_ENV entr(ies) — ` +
            `${unparsed.join(', ')}. Each must be a single-line quoted string ending in a ` +
            `comma; anything else (a template literal, a concatenation, a spread) makes the ` +
            `record unreadable here and this guard stops covering those keys.`,
        );
      }
    }

    expect(problems).toEqual([]);
  });

  it('is accepted by the schema of the app that reads it', async () => {
    const rejections: string[] = [];

    for (const app of apps) {
      const stub = parseStubEnv(app.fixtureFile);
      if (stub === null) continue; // Already reported above; one cause, one failure.

      const result = runLoadEnv(await importEnvModule(app.envFile), stub.entries);
      if (!result.ok) {
        const named = result.keys.length > 0 ? result.keys.join(', ') : result.message;
        rejections.push(
          `${app.label}: STUB_ENV does not satisfy ${ENV_SCHEMA_PATH} — ${named}. Add the key ` +
            `to the STUB_ENV in ${app.label}/${BOOT_GRAPH_TEST_PATH} with a value that satisfies ` +
            `its own validation, or give the schema a default if the value is genuinely ` +
            `optional. (Without this, the same omission surfaces as a ZodError thrown from ` +
            `inside the boot-graph suite's import, which reads as "this service cannot start".)`,
        );
      }
    }

    expect(rejections).toEqual([]);
  }, 60_000);

  it('sets nothing the schema does not declare', async () => {
    const orphans: string[] = [];

    for (const app of apps) {
      const stub = parseStubEnv(app.fixtureFile);
      if (stub === null) continue;

      const result = runLoadEnv(await importEnvModule(app.envFile), stub.entries);
      // A rejecting app declares nothing usable here, and its orphan list would
      // be an artefact of the previous failure rather than a finding.
      if (!result.ok) continue;

      const declared = new Set(result.declared);
      const stale = Object.keys(stub.entries).filter((key) => !declared.has(key));
      if (stale.length > 0) {
        orphans.push(`${app.label}: ${stale.join(', ')}`);
      }
    }

    expect(
      orphans,
      `these STUB_ENV records set keys their app's schema does not declare: ` +
        `${orphans.join(' | ')}. \`loadEnv\` drops undeclared keys before validating (TS-153), ` +
        `so a leftover stub key is silently ignored while still reading as a setting the ` +
        `service needs. Delete it, or fix the spelling against the schema.`,
    ).toEqual([]);
  }, 60_000);
});
