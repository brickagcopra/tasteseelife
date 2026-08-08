import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every downstream the api-gateway's env schema declares must be configured in
 * `.env.example` **and** in the gateway's Kubernetes ConfigMap (TS-505d2-followup-4).
 *
 * **Why this is invisible without a guard.** All the `*_SERVICE_BASE_URL` keys
 * but subscription's are `.optional()` in the gateway's schema — a deliberate
 * choice from the incremental rollout, when most of these workloads did not
 * exist yet. The consequence is that a missing one does not fail boot, does not
 * fail a health probe and does not fail readiness: `DownstreamHttpClient`
 * returns `not_configured` and the route answers **503 on a healthy gateway
 * with a healthy pod behind it**.
 *
 * By the time this was written the fleet had been 31 deployable workloads for a
 * month and the gateway's ConfigMap still named six downstreams. On a cluster
 * that meant provider search, every accounting admin surface, the whole trust &
 * safety console, concierge, academy, ads, media, audit, analytics, notification
 * and payouts all returned 503. Nothing observed it, because every gateway unit
 * test injects its own config and the E2E fleet sets the two or three URLs the
 * spec under test needs.
 *
 * **Ports are checked against the owning service, per environment.** The
 * in-cluster port and the local default legitimately differ — booking is 3015 in
 * k8s and 3027 locally, because k8s gives every pod its own network namespace
 * while the local fleet shares one host (TS-504-followup-1). So the k8s URL is
 * checked against that service's own k8s ConfigMap and the `.env.example` URL
 * against that service's own Zod default. Checking both against one number would
 * force a wrong "fix" in one environment or the other.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const GATEWAY_ENV = path.join(REPO_ROOT, 'apps/api-gateway/src/config/env.ts');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');
const GATEWAY_K8S = path.join(
  REPO_ROOT,
  'infra/kubernetes/services/api-gateway/kustomization.yaml',
);

/** `AUDIT_SERVICE_BASE_URL` → `service-audit`. `TRUST_SAFETY_…` → `service-trust-safety`. */
function serviceDirFor(key: string): string {
  const stem = key
    .replace(/_SERVICE_BASE_URL$/, '')
    .toLowerCase()
    .replace(/_/g, '-');
  return `service-${stem}`;
}

/** Keys the gateway's env schema declares, in declaration order. */
function declaredKeys(): string[] {
  const source = readFileSync(GATEWAY_ENV, 'utf8');
  const found = new Set<string>();
  for (const match of source.matchAll(/^\s{4}([A-Z_]+_SERVICE_BASE_URL):/gm)) {
    found.add(match[1]!);
  }
  return [...found];
}

function envExampleUrls(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z_]+_SERVICE_BASE_URL)=(\S+)$/.exec(line);
    if (match !== null) {
      out.set(match[1]!, match[2]!);
    }
  }
  return out;
}

function k8sUrls(): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(GATEWAY_K8S, 'utf8').split(/\r?\n/)) {
    const match = /^\s+([A-Z_]+_SERVICE_BASE_URL):\s*(\S+)$/.exec(line);
    if (match !== null) {
      out.set(match[1]!, match[2]!);
    }
  }
  return out;
}

/** The `PORT` a service's own k8s base pins, or null when it has no base. */
function k8sPortOf(serviceDir: string): string | null {
  const file = path.join(REPO_ROOT, 'infra/kubernetes/services', serviceDir, 'kustomization.yaml');
  if (!existsSync(file)) return null;
  return /PORT:\s*"(\d+)"/.exec(readFileSync(file, 'utf8'))?.[1] ?? null;
}

/** The `PORT` default a service's Zod schema declares, or null. */
function localPortOf(serviceDir: string): string | null {
  const file = path.join(REPO_ROOT, 'apps', serviceDir, 'src/config/env.ts');
  if (!existsSync(file)) return null;
  return (
    /PORT:\s*z\.coerce\.number\(\)[^,]*?\.default\((\d+)\)/.exec(readFileSync(file, 'utf8'))?.[1] ??
    null
  );
}

function portOf(url: string): string | null {
  return /:(\d+)(?:\/|$)/.exec(url)?.[1] ?? null;
}

describe('api-gateway downstream configuration', () => {
  const keys = declaredKeys();

  /** "Did the walk break?" — see `service-ports.test.ts`. */
  it('discovers the gateway’s declared downstreams', () => {
    expect(keys.length).toBeGreaterThan(15);
    expect(keys).toContain('IDENTITY_SERVICE_BASE_URL');
  });

  it('configures every declared downstream in .env.example', () => {
    const configured = envExampleUrls();
    const missing = keys.filter((key) => !configured.has(key)).sort();
    expect(
      missing,
      'These are `.optional()`, so a missing one does not fail boot — the ' +
        'gateway answers 503 `not_configured` and the surface looks broken ' +
        'rather than unconfigured.',
    ).toEqual([]);
  });

  it('configures every declared downstream in the gateway’s k8s ConfigMap', () => {
    const configured = k8sUrls();
    const missing = keys.filter((key) => !configured.has(key)).sort();
    expect(
      missing,
      'A downstream absent from the ConfigMap answers 503 on a cluster where ' +
        'the pod behind it is healthy and ready.',
    ).toEqual([]);
  });

  it('points each URL at the port that environment’s owning service listens on', () => {
    const fromEnv = envExampleUrls();
    const fromK8s = k8sUrls();
    const mismatches: string[] = [];

    for (const key of keys) {
      const dir = serviceDirFor(key);

      const localExpected = localPortOf(dir);
      const localActual = portOf(fromEnv.get(key) ?? '');
      if (localExpected !== null && localActual !== null && localExpected !== localActual) {
        mismatches.push(
          `.env.example ${key} → :${localActual}, but ${dir}'s schema default is :${localExpected}`,
        );
      }

      const clusterExpected = k8sPortOf(dir);
      const clusterActual = portOf(fromK8s.get(key) ?? '');
      if (clusterExpected !== null && clusterActual !== null && clusterExpected !== clusterActual) {
        mismatches.push(
          `k8s ${key} → :${clusterActual}, but ${dir}'s ConfigMap pins PORT :${clusterExpected}`,
        );
      }
    }

    expect(mismatches).toEqual([]);
  });
});
