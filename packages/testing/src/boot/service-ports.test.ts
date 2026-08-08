import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every service AND worker must declare a distinct default `PORT`
 * (TS-504-followup-1 for the services, TS-505-followup-4 for the workers).
 *
 * **Why this is not obviously necessary, and is.** In Kubernetes the default
 * is irrelevant: `infra/kubernetes/components/nestjs-service/configmap.yaml`
 * sets `PORT: "3000"` for every workload, and each pod owns its own network
 * namespace. That is exactly why six services drifted onto three shared
 * defaults (accounting/booking 3015, messaging/notification 3017,
 * activity/payouts 3018) with nothing complaining. It only bites when the
 * fleet is run from source — the second binder dies with `EADDRINUSE` — and
 * that is precisely what the TS-505 E2E suite has to do.
 *
 * The check lives here rather than in any one service because the property
 * is cross-service: no individual service can observe it. It reads the env
 * schemas as text on purpose — importing 20 config modules would execute
 * their validation, and the declared default is a syntactic fact.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');

/** `PORT: z.coerce.number().int().positive().default(3010),` → 3010 */
const PORT_DEFAULT = /PORT:\s*z\.coerce\.number\(\)[^,]*?\.default\((\d+)\)/;

/** Directories to sweep, and the label prefix each contributes. */
const SCOPES = [
  { dir: APPS_DIR, matches: (entry: string): boolean => entry.startsWith('service-'), label: '' },
  // TS-505-followup-4 — `apps/workers/*` was NOT swept, and the eight workers
  // had drifted onto four shared defaults exactly as the services had. That
  // path has now been missed by three separate sweeps (TS-506's `apps/*/src`
  // grep, TS-504-followup-1's port pass, and the original version of this
  // file), so it is called out here rather than left as an obvious omission.
  { dir: WORKERS_DIR, matches: (): boolean => true, label: 'workers/' },
] as const;

function appsInScope(): { readonly dir: string; readonly name: string; readonly label: string }[] {
  const out: { dir: string; name: string; label: string }[] = [];
  for (const scope of SCOPES) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      if (!scope.matches(entry.name)) continue;
      out.push({
        dir: path.join(scope.dir, entry.name),
        name: entry.name,
        label: `${scope.label}${entry.name}`,
      });
    }
  }
  return out;
}

function serviceDefaultPorts(): ReadonlyMap<string, number> {
  const ports = new Map<string, number>();
  for (const app of appsInScope()) {
    const match = PORT_DEFAULT.exec(readFileSync(path.join(app.dir, 'src/config/env.ts'), 'utf8'));
    if (match?.[1] !== undefined) ports.set(app.label, Number(match[1]));
  }
  return ports;
}

describe('service and worker default PORTs', () => {
  it('finds a declared default for every service and worker', () => {
    const ports = serviceDefaultPorts();
    const serviceCount = appsInScope().length;

    // Guards the regex as much as the services: if the schema's shape changes
    // and this stops matching, the uniqueness assertion below would pass
    // vacuously over an empty map.
    expect(ports.size).toBe(serviceCount);
  });

  it('assigns each service and worker a distinct port', () => {
    const ports = serviceDefaultPorts();
    const byPort = new Map<number, string[]>();
    for (const [service, port] of ports) {
      byPort.set(port, [...(byPort.get(port) ?? []), service]);
    }

    const collisions = [...byPort.entries()]
      .filter(([, services]) => services.length > 1)
      .map(([port, services]) => `${String(port)}: ${services.join(', ')}`);

    // The whole fleet — 20 services, the gateway's 3000, and 9 workers — has to
    // be startable from source simultaneously, which is what TS-505d needs when
    // it adds `worker-outbox-relay` alongside the services.

    expect(collisions).toStrictEqual([]);
  });
});
