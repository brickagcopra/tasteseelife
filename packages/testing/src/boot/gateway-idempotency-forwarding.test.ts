import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * A gateway proxy that issues a downstream **write** must either forward the
 * caller's `Idempotency-Key` or say, at the call site, why it does not.
 *
 * **Why (TS-505d-prep-followup-1).** CLAUDE.md §3.3 requires every write
 * endpoint to accept and respect the header, and §17.5 makes skipping
 * idempotency an absolute prohibition. Neither can hold if the value dies at
 * the edge — and it was dying at **22 of 106 write call sites**, including
 * both halves of the Stripe checkout path, the concierge-request write, and
 * signup, all three of which wear `@Idempotent()` downstream and therefore had
 * a replay cache with nothing to key on.
 *
 * **The primary enforcement is the type, not this file.**
 * `DownstreamCallOptions` is a discriminated union on `method`: the write
 * branch requires `idempotencyKey`, so a new write proxy that ignores the
 * question does not compile. That is stronger than any text scan, and it needs
 * no central list of who is exempt.
 *
 * What the type *cannot* see is the escape hatch. `idempotencyKey: undefined`
 * satisfies the compiler, and it is sometimes the right answer — a read
 * wearing POST (`/search/providers`, `/role-assignments/bulk-preview`), or a
 * hop the gateway synthesises that no client issued (the recommendations
 * aggregator's scoring call). This guard requires those to be *argued*: an
 * explicit `undefined` must carry an `// idempotency:` comment giving the
 * reason.
 *
 * The reason lives at the call site deliberately. A central exemption list is
 * a place for the next omission to hide in — the reviewer of a new proxy sees
 * a list entry, not the code, and "it's already on the list" reads as settled.
 * A comment three lines above the call is read by whoever changes the call.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GATEWAY_SRC = path.join(REPO_ROOT, 'apps', 'api-gateway', 'src');

/** Methods whose call sites must answer the question. Mirrors `DownstreamWriteMethod`. */
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly method: string;
  readonly body: string;
}

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
      if (entry.endsWith('.controller.ts') && !entry.endsWith('.test.ts')) found.push(full);
    }
  };
  walk(dir);
  return found;
}

/**
 * Extract every `downstream.call({ ... })` options literal by brace matching.
 *
 * A regex cannot do this: the options object contains nested objects
 * (`extraHeaders`), template literals with `${}` interpolation in `path`, and
 * spreads. Counting braces from the first `{` after the call is the only way
 * to get the whole literal and nothing but it.
 */
function callSites(file: string): CallSite[] {
  const src = readFileSync(file, 'utf8');
  const sites: CallSite[] = [];
  const marker = 'downstream.call';
  let cursor = 0;

  for (;;) {
    const found = src.indexOf(marker, cursor);
    if (found === -1) break;
    const open = src.indexOf('{', found);
    if (open === -1) break;

    let depth = 0;
    let close = open;
    for (; close < src.length; close += 1) {
      const ch = src[close];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }

    const body = src.slice(open, close + 1);
    const declared = /method:\s*'([A-Z]+)'/.exec(body);
    sites.push({
      file: path.relative(REPO_ROOT, file),
      line: src.slice(0, found).split('\n').length,
      // A `method:` whose value is not a literal (a union-typed variable on a
      // shared private helper) is reported as DYNAMIC and treated as a write —
      // erring toward asking the question.
      method: declared?.[1] ?? (/method:/.test(body) ? 'DYNAMIC' : 'GET'),
      body,
    });
    cursor = close + 1;
  }
  return sites;
}

const isWrite = (site: CallSite): boolean =>
  site.method === 'DYNAMIC' || (WRITE_METHODS as readonly string[]).includes(site.method);

describe('gateway Idempotency-Key forwarding', () => {
  const sites = controllerFiles(GATEWAY_SRC).flatMap(callSites);
  const writes = sites.filter(isWrite);

  it('discovers the downstream call sites to check', () => {
    // A brace-matcher that stops matching must not turn "no offenders" into
    // "no data" — the same floor `service-ports.test.ts` and
    // `internal-header-names.test.ts` carry. Floors, not exact counts: new
    // proxies land often and a fixed number would be a chore, not a check.
    expect(sites.length).toBeGreaterThan(180);
    expect(writes.length).toBeGreaterThan(90);
  });

  it('names an idempotencyKey on every downstream write', () => {
    const offenders = writes
      .filter((site) => !/idempotencyKey/.test(site.body))
      .map((site) => `${site.file}:${site.line} (${site.method})`);

    expect(
      offenders,
      "These downstream writes drop the caller's Idempotency-Key, so the downstream " +
        '@Idempotent() cache has nothing to key on and a client retry duplicates the write ' +
        '(CLAUDE.md §3.3 / §17.5). Forward it, or pass `undefined` with an `// idempotency:` ' +
        'comment giving the reason.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('requires a stated reason wherever a write opts out', () => {
    const offenders = writes
      .filter((site) => /idempotencyKey:\s*undefined/.test(site.body))
      .filter((site) => !/\/\/\s*idempotency:/.test(site.body))
      .map((site) => `${site.file}:${site.line} (${site.method})`);

    expect(
      offenders,
      'A write passing `idempotencyKey: undefined` is claiming there is nothing to collapse — ' +
        'a read wearing POST, or a hop the gateway synthesises that no client issued. That is a ' +
        'real answer, but it has to be written down where the next person changing this call ' +
        'will read it. Add an `// idempotency: <reason>` comment beside the property.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('has at least one opted-out write, so the reason check is not vacuous', () => {
    // Without this, a refactor that made every write forward would leave the
    // guard above passing over an empty set — and the day someone opts out
    // again, nothing would have been exercising the rule.
    const optedOut = writes.filter((site) => /idempotencyKey:\s*undefined/.test(site.body));
    expect(optedOut.length).toBeGreaterThan(0);
  });
});
