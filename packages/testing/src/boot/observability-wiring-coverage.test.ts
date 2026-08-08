import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every Nest workload boots the shared observability bootstrap
 * (TS-504-followup-2a-3).
 *
 * **Why this exists.** TS-504-followup-2a-2 found six workloads —
 * `worker-accounting-metrics`, `worker-analytics-aggregator`,
 * `worker-certification-renewal`, `worker-search-indexer`,
 * `worker-stripe-reconciliation`, `worker-wellness-summary` — that had no
 * observability wiring of any kind. No bootstrap shim, no OTel env keys, no
 * shutdown chain, and a private copy of the exception filter instead of the
 * shared one. They emitted no traces, no metrics and no error reports, and
 * they had been doing that since they were scaffolded. TS-306-followup-1d's
 * "observability fleet is now 21/21" was true of the workloads it counted;
 * these six were never in the set, so nothing ever said a number was missing.
 *
 * They were found by accident: three unrelated fleet-wide edits, each anchored
 * on a different marker, skipped exactly the same six workspaces. That is not
 * a detection mechanism.
 *
 * **Why it checks six things and not one.** The wiring is six separate
 * conventions that a service scaffolded from a stale template gets none of,
 * and any one of them missing is silent — a workload with a bootstrap shim it
 * never imports looks wired to a reviewer grepping for the file, and a
 * ConfigMap that sets a key no schema declares configures nothing while
 * looking like configuration (the defect TS-306-followup-1c found).
 *
 * **Why the workload list is derived from the filesystem.** A hardcoded list
 * would have to be edited by the same person who forgot the wiring, which is
 * the failure this guard exists to catch. `src/main.ts` is the definition of a
 * Nest workload here and it cannot be omitted by accident.
 *
 * **Why textual assertions rather than executing anything.** Unlike
 * `env-example-coverage.test.ts`, which has to run the schemas because only
 * execution answers "would this boot", every property here is structural:
 * a file exists, an import comes first, a name matches. Importing 30
 * `main.ts` files would execute 30 `NestFactory.create` calls.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');
const WORKERS_DIR = path.join(APPS_DIR, 'workers');
const K8S_SERVICES_DIR = path.join(REPO_ROOT, 'infra/kubernetes/services');

interface Workload {
  /** Directory name under `apps/` or `apps/workers/`. */
  readonly dir: string;
  /**
   * The name the workload calls itself — `service-identity`,
   * `worker-search-indexer`. Workers live at `apps/workers/<x>` but are named
   * `worker-<x>` everywhere else (k8s base, service name, log lines).
   */
  readonly name: string;
  readonly root: string;
}

/**
 * Every Nest workload: a directory under `apps/` or `apps/workers/` with a
 * `src/main.ts`. That excludes the four Next portals (no `main.ts`) and
 * `apps/e2e` (a Playwright harness, not a workload).
 */
function nestWorkloads(): readonly Workload[] {
  const out: Workload[] = [];
  for (const scope of [
    { dir: APPS_DIR, prefix: '' },
    { dir: WORKERS_DIR, prefix: 'worker-' },
  ]) {
    for (const entry of readdirSync(scope.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'workers') continue;
      const root = path.join(scope.dir, entry.name);
      if (!existsSync(path.join(root, 'src/main.ts'))) continue;
      out.push({ dir: entry.name, name: `${scope.prefix}${entry.name}`, root });
    }
  }
  return out;
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

const WORKLOADS = nestWorkloads();

describe('observability wiring coverage', () => {
  it('finds the whole Nest fleet', () => {
    // A guard that silently enumerated nothing would pass every assertion
    // below. Pin the floor so a broken enumerator fails loudly instead.
    expect(WORKLOADS.length).toBeGreaterThanOrEqual(30);
    expect(WORKLOADS.map((w) => w.name)).toContain('service-identity');
    expect(WORKLOADS.map((w) => w.name)).toContain('worker-search-indexer');
  });

  describe.each(WORKLOADS.map((w) => [w.name, w] as const))('%s', (_name, workload) => {
    it('has an observability bootstrap shim naming itself', () => {
      const shim = path.join(workload.root, 'src/observability/bootstrap.ts');
      expect(existsSync(shim), `${workload.name}: missing src/observability/bootstrap.ts`).toBe(
        true,
      );
      // The name is what every span, metric and Sentry event is attributed to.
      // A shim copied from a sibling and left unedited is worse than none: the
      // telemetry arrives, under another workload's name.
      expect(read(shim)).toContain(`createObservabilityBootstrap('${workload.name}')`);
    });

    it('imports the shim as the FIRST import in main.ts', () => {
      // `@opentelemetry/auto-instrumentations-node` patches `http`, `pg`,
      // `ioredis` and Nest at module-load time. An import above this one is
      // instrumentation lost — and it looks completely fine.
      const main = read(path.join(workload.root, 'src/main.ts'));
      const firstImport = /^import .*$/m.exec(main)?.[0];
      expect(firstImport, `${workload.name}: main.ts has no imports`).toBeDefined();
      expect(firstImport).toContain('./observability/bootstrap');
    });

    it('flushes traces, metrics and Sentry on shutdown', () => {
      // The errors worth having are disproportionately the ones thrown on the
      // way down, and an unflushed client drops them.
      const main = read(path.join(workload.root, 'src/main.ts'));
      for (const fn of ['shutdownTracing()', 'shutdownMetrics()', 'shutdownSentry()']) {
        expect(main, `${workload.name}: main.ts never calls ${fn}`).toContain(fn);
      }
    });

    it('registers ObservabilityModule in the AppModule', () => {
      // Without it there is no `/metrics` scrape route and no
      // SentryStatusReporter, so a workload with no DSN never says so.
      const appModule = path.join(workload.root, 'src/app.module.ts');
      expect(existsSync(appModule), `${workload.name}: no src/app.module.ts`).toBe(true);
      expect(read(appModule)).toContain('ObservabilityModule');
    });

    it('declares the observability env keys in its schema', () => {
      // TS-153's key-pick drops keys the schema does not declare, so an
      // undeclared key set in the ConfigMap is silently discarded.
      const env = path.join(workload.root, 'src/config/env.ts');
      expect(existsSync(env), `${workload.name}: no src/config/env.ts`).toBe(true);
      const source = read(env);
      for (const key of ['OTEL_TRACES_ENABLED', 'OTEL_METRICS_ENABLED', 'SENTRY_DSN']) {
        expect(source, `${workload.name}: env schema does not declare ${key}`).toContain(key);
      }
    });

    it('states its observability posture in the k8s ConfigMap', () => {
      // All three have safe defaults, so this is not about the pod booting —
      // it is so an operator reading the manifest can see whether the workload
      // reports, without inferring it from a Zod default in another repo path.
      const base = path.join(K8S_SERVICES_DIR, workload.name, 'kustomization.yaml');
      expect(existsSync(base), `${workload.name}: no k8s base at ${base}`).toBe(true);
      const manifest = read(base);
      for (const key of ['OTEL_TRACES_ENABLED', 'OTEL_METRICS_ENABLED', 'SENTRY_DSN']) {
        expect(manifest, `${workload.name}: k8s ConfigMap does not set ${key}`).toContain(key);
      }
    });
  });
});

/**
 * The Next portals (TS-504-followup-2a-1).
 *
 * They are not Nest workloads — no `main.ts`, no `ObservabilityModule`, no
 * OTel — so the fleet sweep above correctly skips them, and that is exactly
 * why they need their own. A fifth portal added by copying a directory would
 * join the estate with no error reporting and nothing red, which is the
 * silent-shrinkage failure TS-504-followup-2a-3 exists to prevent for the Nest
 * side.
 *
 * Sentry is the only one of the three channels a portal carries today: traces
 * and metrics would need an OTLP path these apps do not have.
 */
function nextPortals(): readonly Workload[] {
  const out: Workload[] = [];
  for (const entry of readdirSync(APPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const root = path.join(APPS_DIR, entry.name);
    // The discriminator is the Next config, not the `web-` prefix.
    if (
      !['next.config.ts', 'next.config.mjs', 'next.config.js'].some((n) =>
        existsSync(path.join(root, n)),
      )
    )
      continue;
    out.push({ dir: entry.name, name: entry.name, root });
  }
  return out;
}

const PORTALS = nextPortals();

describe('portal error-reporting wiring coverage', () => {
  it('finds every Next portal', () => {
    expect(PORTALS.length).toBeGreaterThanOrEqual(4);
    expect(PORTALS.map((p) => p.name)).toContain('web-marketing');
  });

  describe.each(PORTALS.map((p) => [p.name, p] as const))('%s', (_name, portal) => {
    it('registers Sentry per runtime from instrumentation.ts', () => {
      const file = path.join(portal.root, 'instrumentation.ts');
      expect(existsSync(file), `${portal.name}: missing instrumentation.ts`).toBe(true);
      const source = read(file);

      // Both branches. A `register()` that loaded only the Node config would
      // leave middleware — the one place a request can fail before any page
      // code runs — reporting nothing.
      expect(
        source,
        `${portal.name}: instrumentation.ts does not load the server config`,
      ).toContain('./sentry.server.config');
      expect(source, `${portal.name}: instrumentation.ts does not load the edge config`).toContain(
        './sentry.edge.config',
      );

      // Without `onRequestError`, Next catches server-component and route-
      // handler errors at its own boundary and they never reach Sentry — an
      // initialised client that sees almost nothing, which is the
      // TS-306-followup-1c "instrumentation exists and reports nothing" shape.
      expect(source, `${portal.name}: instrumentation.ts does not export onRequestError`).toContain(
        'onRequestError',
      );
    });

    it('initialises both runtimes through the shared options builder', () => {
      for (const name of ['sentry.server.config.ts', 'sentry.edge.config.ts']) {
        const file = path.join(portal.root, name);
        expect(existsSync(file), `${portal.name}: missing ${name}`).toBe(true);
        const source = read(file);
        // Shared, not re-derived: four portals must not grow four redaction
        // policies. `portalSentryOptions` is where `sendDefaultPii: false`,
        // `tracesSampleRate: 0` and the scrubbers live.
        expect(source, `${portal.name}/${name}: does not use portalSentryOptions`).toContain(
          'portalSentryOptions',
        );
        expect(source, `${portal.name}/${name}: does not read SENTRY_DSN`).toContain('SENTRY_DSN');
      }
    });

    it('ships no browser SDK', () => {
      // The deliberate absence, asserted so it stays deliberate. The browser
      // SDK carries session replay and DOM-interaction breadcrumbs, and these
      // portals render a named senior's care schedule — a §12 / PDD §16.3
      // consent question that nobody has answered in writing. Adding a client
      // config should require deleting this test, and therefore reading it.
      for (const name of ['sentry.client.config.ts', 'instrumentation-client.ts']) {
        expect(
          existsSync(path.join(portal.root, name)),
          `${portal.name}: ${name} exists — the browser SDK is a consent decision ` +
            `(§12, PDD §16.3), not a configuration default. See TS-504-followup-2a-1.`,
        ).toBe(false);
      }
    });

    it('supplies SENTRY_DSN and a release version in its k8s ConfigMap', () => {
      const base = path.join(K8S_SERVICES_DIR, portal.name, 'kustomization.yaml');
      expect(existsSync(base), `${portal.name}: no k8s base at ${base}`).toBe(true);
      const manifest = read(base);
      // SERVICE_VERSION too: the release tag is `web-family@<version>`, and
      // without it every portal deploy reports as `@dev` — a tag that is set
      // and tells you nothing, which is the failure the acceptance names.
      for (const key of ['SENTRY_DSN', 'SERVICE_VERSION']) {
        expect(manifest, `${portal.name}: k8s ConfigMap does not set ${key}`).toContain(key);
      }
    });
  });
});
