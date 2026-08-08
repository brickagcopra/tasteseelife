import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every schema that owns an `outbox_events` table must be drained by the relay
 * (TS-505d2-followup-1).
 *
 * **Why this exists.** The relay reads undispatched rows from each
 * `{schema}.outbox_events` listed in `OUTBOX_SOURCES` and publishes them onto
 * Redis Streams (PDD §7.3). A schema absent from that list still gets written
 * to — `OutboxService.append` knows nothing about the relay — so its events
 * accumulate, undispatched, forever. Nothing errors. Nothing alerts. The
 * producing service's tests pass, the consuming service's tests pass, and the
 * event simply never arrives.
 *
 * **It had already failed twice when this landed.**
 *   - `search.outbox_events` appeared in **no** source list, while
 *     `SearchAnalyticsEmitter` and `SearchClickEmitter` appended to it on every
 *     search and every click — and `service-analytics` had `SearchPerformedHandler`
 *     and `SearchResultClickedHandler` registered and waiting. Producer and
 *     consumer were both built and correct; only the drain was missing.
 *   - `accounting.outbox_events` was listed in `.env.example` but not in the k8s
 *     ConfigMap, so local and deployed disagreed about what gets published.
 *
 * **The rule the fix adopted, which this enforces.** The list is derived from
 * *the table existing*, not from a producer existing. "Add the source when the
 * first producer lands" is precisely the rule that failed above: the producer
 * author has no reason to think about relay configuration, and nothing connects
 * the two. Draining a table with no producer costs one indexed lookup against
 * the `dispatched_at IS NULL` partial index per poll; missing a live one loses
 * events silently.
 *
 * **Why a text scan of the manifest.** Same reasoning as the other guards here:
 * rendering the overlay needs `kubectl kustomize --enable-helm`, which is
 * CI-only on this machine (TS-300-followup-2), while the ConfigMap literal is a
 * syntactic fact in the file. This also means the check sees what a reviewer
 * sees. No overlay patches `OUTBOX_SOURCES`, so the base value is what ships in
 * every environment.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const RELAY_KUSTOMIZATION = path.join(
  REPO_ROOT,
  'infra/kubernetes/services/worker-outbox-relay/kustomization.yaml',
);

/**
 * Postgres schemas that own an `outbox_events` table, read from each service's
 * own Prisma schema.
 *
 * The table is recognised by its `@@map("outbox_events")` and the owning schema
 * by the `schemas = [...]` on the datasource — every service here declares
 * exactly one. Asking the Prisma schema is the point: it is the artefact that
 * creates the table, so a new producer service cannot be added without this
 * check noticing.
 */
function schemasOwningAnOutboxTable(): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(APPS_DIR, entry.name, 'prisma/schema.prisma');
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      // Most workspaces under `apps/` own no Prisma schema (the portals, the
      // gateway, the workers). Absence is not a failure.
      continue;
    }
    if (!/@@map\("outbox_events"\)/.test(source)) continue;
    const declared = /schemas\s*=\s*\[\s*"([a-z_]+)"/.exec(source);
    if (declared?.[1] !== undefined) found.push(declared[1]);
  }
  return [...new Set(found)].sort();
}

/** Parse a `schema.outbox_events,...` list into its schema names. */
function sourceSchemas(value: string): readonly string[] {
  return [
    ...new Set(
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => entry.replace(/\.outbox_events$/, '')),
    ),
  ].sort();
}

function envExampleSources(): readonly string[] {
  const source = readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
  const match = /^OUTBOX_SOURCES=(.*)$/m.exec(source);
  if (match?.[1] === undefined) throw new Error('OUTBOX_SOURCES is not set in .env.example');
  return sourceSchemas(match[1]);
}

function manifestSources(): readonly string[] {
  const source = readFileSync(RELAY_KUSTOMIZATION, 'utf8');
  const match = /^\s*OUTBOX_SOURCES:\s*(\S+)\s*$/m.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("OUTBOX_SOURCES is not set in worker-outbox-relay's kustomization.yaml");
  }
  return sourceSchemas(match[1]);
}

describe('the outbox relay drains every schema that owns an outbox table', () => {
  const owners = schemasOwningAnOutboxTable();

  it('discovers the schemas that own an outbox_events table', () => {
    // The "did the walk break?" assertion every guard in this directory
    // carries. If the Prisma scan silently stopped matching, both checks
    // below would pass against an empty set and mean nothing. There were 11
    // at the time of writing.
    expect(owners.length).toBeGreaterThanOrEqual(11);
  });

  it('is configured to drain all of them in .env.example', () => {
    expect(envExampleSources(), undrainedMessage('.env.example')).toEqual(owners);
  });

  it('is configured to drain all of them in the k8s ConfigMap', () => {
    expect(manifestSources(), undrainedMessage('the worker-outbox-relay ConfigMap')).toEqual(
      owners,
    );
  });
});

function undrainedMessage(where: string): string {
  return (
    `OUTBOX_SOURCES in ${where} does not match the set of schemas that own an ` +
    `outbox_events table. A schema that is written to but not drained accumulates ` +
    `undispatched rows forever and its events never reach a consumer — silently, ` +
    `with both sides' tests green (that is exactly how search.outbox_events was ` +
    `missed). List every schema that owns the table, whether or not it has a ` +
    `producer yet, and keep .env.example and the ConfigMap identical.`
  );
}
