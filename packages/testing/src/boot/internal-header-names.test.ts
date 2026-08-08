import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every internal shared-secret **header name** must agree across the service
 * that presents it and the service that reads it (TS-505d2-followup-5c).
 *
 * **Filed because TS-505d2-followup-5's own E2E caught this defect on its
 * first run.** The fleet pinned `HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME`
 * on service-household and left the api-gateway on its default, so every
 * membership lookup 401'd. **The symptom was invisible in the HTTP
 * response** — the household-scope resolver fails closed, so the surface
 * returned the same 400 it had always returned; only a WARN line in the
 * gateway log named it. That is the third defect this session that lived
 * strictly between two green unit suites, in configuration neither side can
 * observe alone.
 *
 * **The property.** A pair like `HOUSEHOLD_MEMBERSHIPS_INTERNAL_*` is
 * declared independently in two Zod schemas, each with its own hand-written
 * `.default(...)`. Nothing has ever checked that the two defaults are the
 * same string. When they diverge the caller sends a header the callee never
 * reads, and every request across that seam is a 401 that looks like a
 * secret-rotation problem.
 *
 * **Why a text scan.** Same reasoning as `service-ports.test.ts`: importing
 * twenty config modules would execute their validation (and several demand
 * secrets), while the declared default is a syntactic fact sitting in the
 * file. This also means the check sees what a reviewer sees.
 *
 * **What it deliberately does NOT check.** That a pair has exactly two
 * declarers. A surface may legitimately have one producer and several
 * consumers, or — during a rollout — a declarer with no counterpart yet. The
 * property is agreement among those that DO declare it, not arity.
 *
 * ---
 *
 * **The manifests are checked too, and they are where the next one hid
 * (TS-042-followup-3a1a-followup-2).**
 *
 * Everything above compares CODE DEFAULTS. TS-042-followup-3a1a found a
 * defect that check was structurally blind to: service-notification's
 * kustomization set `HOUSEHOLD_MEMBERSHIPS_INTERNAL_HEADER_NAME:
 * x-internal-api-key` **explicitly**, overriding a default that had already
 * been corrected. Caller and reader disagreed in every deployed cluster while
 * this file stayed green, and the symptom — a 401 on every dunning-recipient
 * resolution — reads as a rotated secret rather than a typo.
 *
 * **A manifest value that disagrees with the reader is strictly worse than a
 * wrong default**, because it only bites where nobody is running a test.
 *
 * So the effective value per app is `manifest literal ?? code default`, and
 * agreement is asserted over that. The manifest is authoritative because it
 * is what actually reaches the pod.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');
const K8S_SERVICES_DIR = path.join(REPO_ROOT, 'infra/kubernetes/services');

/**
 * `SOME_HEADER_NAME: z.string().min(1).default('x-foo'),` — across line
 * breaks, because prettier wraps the longer ones. Non-greedy up to the first
 * `.default(...)` so a later `.default` on a different key cannot be
 * captured.
 */
const HEADER_DEFAULT = /(\w*_HEADER_NAME):\s*z[\s\S]{0,200}?\.default\(\s*'([^']*)'\s*\)/g;

/**
 * `SOME_HEADER_NAME: x-foo` inside a kustomization's literal env block.
 * Unquoted, quoted and single-quoted forms all appear in these files.
 */
const MANIFEST_HEADER_LITERAL = /(\w*_HEADER_NAME):\s*["']?([^"'\s#]+)["']?/g;

interface Declaration {
  readonly app: string;
  readonly key: string;
  readonly value: string;
  /** Where the value came from — named in the failure so it can be fixed. */
  readonly source: 'env schema default' | 'k8s manifest';
}

function envSchemaFiles(): { readonly app: string; readonly file: string }[] {
  const out: { app: string; file: string }[] = [];
  const scopes = [
    { dir: APPS_DIR, label: '' },
    { dir: WORKERS_DIR, label: 'workers/' },
  ];
  for (const scope of scopes) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      const file = path.join(scope.dir, entry.name, 'src/config/env.ts');
      try {
        readFileSync(file, 'utf8');
      } catch {
        // Not every workspace under `apps/` owns an env schema (the web apps
        // validate elsewhere). Absence is not a failure.
        continue;
      }
      out.push({ app: `${scope.label}${entry.name}`, file });
    }
  }
  return out;
}

function declarations(): readonly Declaration[] {
  const out: Declaration[] = [];
  for (const { app, file } of envSchemaFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(HEADER_DEFAULT)) {
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined) continue;
      out.push({ app, key, value, source: 'env schema default' });
    }
  }
  return out;
}

/**
 * Header-name literals set in each service's kustomization.
 *
 * The manifest directory is named after the workload (`service-notification`,
 * `worker-outbox-relay`), which is the same label the env-schema walk
 * produces for services and a `worker-`/`workers/` swap for workers. Both are
 * normalised so a manifest and a schema for the same workload land in the
 * same app bucket and their disagreement is visible.
 */
function manifestDeclarations(): readonly Declaration[] {
  const out: Declaration[] = [];
  let entries: readonly string[];
  try {
    entries = readdirSync(K8S_SERVICES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return out;
  }

  for (const entry of entries) {
    const file = path.join(K8S_SERVICES_DIR, entry, 'kustomization.yaml');
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const app = entry.startsWith('worker-') ? `workers/${entry.slice('worker-'.length)}` : entry;
    for (const match of source.matchAll(MANIFEST_HEADER_LITERAL)) {
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined) continue;
      out.push({ app, key, value, source: 'k8s manifest' });
    }
  }
  return out;
}

/**
 * The value each app actually runs with: the manifest literal where one
 * exists, otherwise the code default. A manifest that agrees with its own
 * default contributes nothing new; one that disagrees REPLACES it, because
 * that is what reaches the pod.
 *
 * Keeping this as one list rather than checking the two layers separately is
 * deliberate: the failure mode being guarded is a manifest disagreeing with
 * ANOTHER SERVICE's reader, which neither layer shows on its own.
 */
function effectiveDeclarations(): readonly Declaration[] {
  const byAppKey = new Map<string, Declaration>();
  for (const declaration of declarations()) {
    byAppKey.set(`${declaration.app}::${declaration.key}`, declaration);
  }
  for (const declaration of manifestDeclarations()) {
    byAppKey.set(`${declaration.app}::${declaration.key}`, declaration);
  }
  return [...byAppKey.values()];
}

describe('internal shared-secret header names', () => {
  const found = effectiveDeclarations();

  it('discovers the header-name declarations across the fleet', () => {
    // The "did the walk break?" assertion every guard in this directory
    // carries. A regex that silently stops matching turns a real check into
    // a green no-op, which is worse than no check at all. There were 21 at
    // the time of writing; the floor allows growth and catches collapse.
    expect(found.length).toBeGreaterThanOrEqual(18);
  });

  it('agrees on the value of every header name declared in more than one app', () => {
    const byKey = new Map<string, Declaration[]>();
    for (const declaration of found) {
      const bucket = byKey.get(declaration.key) ?? [];
      bucket.push(declaration);
      byKey.set(declaration.key, bucket);
    }

    const conflicts: string[] = [];
    for (const [key, group] of byKey) {
      const distinct = new Set(group.map((d) => d.value));
      if (distinct.size <= 1) continue;
      const detail = group.map((d) => `${d.app} declares '${d.value}' (${d.source})`).join('; ');
      conflicts.push(
        `${key}: ${detail}. The caller would send a header the callee never reads, and every ` +
          `request across that seam becomes a 401 that looks like a rotation problem.`,
      );
    }

    expect(conflicts).toEqual([]);
  });

  it('reads header names out of the k8s manifests, not only the code defaults', () => {
    // The walk-did-not-break assertion for the manifest half specifically. A
    // corrected code default does NOT fix an environment that sets the value
    // explicitly, and that is exactly how TS-042-followup-3a1a's live defect
    // survived: this file was green while every deployed dunning-recipient
    // resolution 401'd.
    const fromManifests = manifestDeclarations();
    expect(fromManifests.length).toBeGreaterThanOrEqual(3);
  });

  it('lets a manifest literal override its own code default', () => {
    // Not a style preference — it is the ordering that makes the check
    // meaningful. If the code default won, a manifest disagreeing with
    // another service's reader would be invisible, which is the whole bug.
    const overridden = effectiveDeclarations().filter((d) => d.source === 'k8s manifest');
    expect(overridden.length).toBeGreaterThan(0);
  });

  it('shares at least one header name between two apps, so the check has something to check', () => {
    // Without this, a refactor that made every key app-unique would leave the
    // assertion above vacuously true and nobody would notice.
    const counts = new Map<string, Set<string>>();
    for (const declaration of found) {
      const apps = counts.get(declaration.key) ?? new Set<string>();
      apps.add(declaration.app);
      counts.set(declaration.key, apps);
    }
    const shared = [...counts.values()].filter((apps) => apps.size > 1);
    expect(shared.length).toBeGreaterThan(0);
  });
});
