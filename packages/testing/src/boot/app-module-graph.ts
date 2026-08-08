/**
 * Boot-graph guard (TS-506 / ADR-0005).
 *
 * **The blind spot this closes.** Every service's unit suite builds narrow
 * `Test.createTestingModule` graphs out of hand-picked providers and mocks.
 * Nothing instantiated the real `AppModule`, so a provider that no module
 * declared stayed invisible until a process actually booted — and 8 of 20
 * services could not boot at all while their ~2,000 tests were green. The
 * causes were all different (a shared SDK's dependencies declared in the
 * wrong module; a `HealthModule` that never imported the module exporting
 * the token its controller injects; `@Injectable()` emitters registered
 * nowhere; constructor params whose default values do not stop Nest
 * injecting them). What they shared was that no test ever asked Nest to
 * resolve the whole graph.
 *
 * `compile()` is exactly that question and no more. It runs the injector
 * over every module in the tree, which is where `UnknownDependencies-
 * Exception` is raised — and it stops short of `init()`, so no
 * `onModuleInit` runs and nothing opens a socket. That is deliberate:
 * this guard must stay a fast, hermetic unit test, or it will not be run.
 * Postgres/Redis behaviour belongs to the integration suites.
 *
 * Note what it therefore does NOT catch: a dependency injected only by a
 * bare constructor param type. vitest/esbuild emits no
 * `design:paramtypes`, so those resolve to `undefined` under this runner
 * rather than failing. Explicitly `@Inject(TOKEN)`-decorated params and
 * `inject: [...]` factory arrays — which is how the TS-506 failures
 * presented — are covered.
 */
import { Test } from '@nestjs/testing';

export interface AppModuleGraphOptions {
  /**
   * Stub environment the service's `loadEnv()` must accept. Applied to
   * `process.env` BEFORE the app module is imported, because every
   * service validates its env at module-import time.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Dynamic import of the service's composition root, e.g.
   * `() => import('../src/app.module')`. A thunk, not a value: the
   * import must happen after `env` is applied.
   */
  readonly importAppModule: () => Promise<Record<string, unknown>>;
  /** Exported class name. Defaults to `AppModule`. */
  readonly exportName?: string;
}

/**
 * Compiles the service's real `AppModule` and asserts every dependency
 * resolves. Throws with Nest's own diagnostic — which names the missing
 * token, the consuming class and the module context — if it does not.
 *
 * Restores any `process.env` keys it overwrote, so a suite that runs this
 * alongside other tests does not leak stub credentials into them.
 */
export async function compileAppModuleGraph(options: AppModuleGraphOptions): Promise<void> {
  const { env, importAppModule, exportName = 'AppModule' } = options;

  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    const module = await importAppModule();
    const appModule = module[exportName];
    if (appModule === undefined) {
      throw new Error(`app module export '${exportName}' not found`);
    }

    const moduleRef = await Test.createTestingModule({
      imports: [appModule as never],
    }).compile();

    // `compile()` already resolved the graph; closing releases whatever
    // the instance loader constructed without running lifecycle hooks.
    await moduleRef.close();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}
