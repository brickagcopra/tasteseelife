import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A method-level `@UsePipes(new ZodValidationPipe(X))` must not sit on a route
 * that also takes a path parameter.
 *
 * **Why (TS-505d-prep).** Nest applies a method-level pipe to *every* handler
 * argument, not just the body — so `@Param('id') id: string` is run through
 * the body schema and fails. The route then answers
 * `400 Expected object, received string` to every caller, forever, with no
 * input that can satisfy it.
 *
 * When this guard was written the repo had **33 such routes across six
 * services** — the whole booking lifecycle (accept / decline / status /
 * check-in), every subscription mutation (pause / resume / cancel / change),
 * journal reversal, period close and reopen, senior consent, senior intake,
 * and provider profile / pricing / availability / service-areas /
 * certifications. None had ever been observed, because a second defect
 * (TS-140-followup-1a) meant nothing could reach a downstream route at all.
 *
 * **Why a text check and not a runtime one.** The failure is a property of
 * the decorator pair, and it is invisible to the suites that would otherwise
 * catch it: a controller unit test constructs the class and calls the method
 * directly, so Nest's pipe pipeline never runs. Only a real HTTP request
 * through the framework sees it, and the E2E suite covers a handful of routes,
 * not thirty-three. Reading the source is what makes the check exhaustive.
 *
 * **The fix is always the same**: move the pipe onto the parameter it was
 * written for — `@Body(new ZodValidationPipe(X))` (or `@Query(...)`).
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

const ROUTE_DECORATOR = /^ {2}@(Post|Get|Put|Patch|Delete)\(/;
const METHOD_LEVEL_PIPE = /^ {2}@UsePipes\(new ZodValidationPipe\(/;
const PATH_PARAM = /@Param\(/;

function controllerFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
        continue;
      }
      if (entry.endsWith('.controller.ts')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Every route whose decorator block carries BOTH a method-level pipe and a path param. */
function offendingRoutes(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, index) => {
    if (ROUTE_DECORATOR.test(line)) starts.push(index);
  });

  const offenders: string[] = [];
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? (starts[i + 1] as number) : lines.length;
    const block = lines.slice(start, end);
    if (!block.some((line) => METHOD_LEVEL_PIPE.test(line))) return;
    if (!block.some((line) => PATH_PARAM.test(line))) return;
    offenders.push(`${path.relative(REPO_ROOT, file)} → ${(block[0] as string).trim()}`);
  });
  return offenders;
}

describe('controller validation pipes', () => {
  const files = readdirSync(APPS_DIR)
    .filter((name) => name.startsWith('service-') || name === 'api-gateway')
    .map((name) => path.join(APPS_DIR, name, 'src'))
    .flatMap((src) => controllerFiles(src));

  it('discovers the controllers to check', () => {
    // A regex that stops matching must not be able to turn "no offenders"
    // into "no data" — the same guard `service-ports.test.ts` carries.
    expect(files.length).toBeGreaterThan(100);
  });

  it('never applies a method-level ZodValidationPipe to a route with a path parameter', () => {
    const offenders = files.flatMap(offendingRoutes);
    expect(
      offenders,
      'A method-level @UsePipes runs the schema against @Param too, so these routes 400 for every caller. ' +
        'Move the pipe onto @Body()/@Query().\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });
});
