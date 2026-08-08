const { readFileSync } = require('node:fs');

const ts = require('typescript');

/**
 * A Vite/Vitest plugin that compiles `.ts` with TypeScript instead of esbuild,
 * so `emitDecoratorMetadata` actually happens (TS-305d-followup-2b1).
 *
 * **The problem it exists for.** Nest resolves a constructor parameter that
 * carries no `@Inject(...)` through the `design:paramtypes` metadata the
 * compiler emits. `packages/tsconfig/base.json` sets `emitDecoratorMetadata`
 * and `tsc` honours it, so the shipped artifacts are correct — but vitest
 * compiles with **esbuild, which cannot emit that metadata at all**. It is a
 * documented upstream limitation, not a setting we forgot.
 *
 * Nest does not error on the result. With no `design:paramtypes` it reads a
 * class as having zero dependencies, merges in whatever `@Inject`-decorated
 * indices exist, and constructs the object with holes where the rest belong.
 * No "cannot resolve dependencies" message: the object is built, the routes are
 * mounted, and the first call touching a missing dependency throws
 * `TypeError: Cannot read properties of undefined`.
 *
 * **What that cost.** Two things, both discovered on the same day:
 *
 *   - `service-provider`'s `/readyz` returned 503 against a live, migrated
 *     Postgres because the health controller's `prisma` was undefined
 *     (TS-305d-followup-2b).
 *   - Once TS-506-followup-3b revived the integration lane's env fixtures,
 *     14 of `service-search`'s 17 tests failed inside `RankingConfigController`
 *     for the same reason. **The lane could not exercise any controller on this
 *     platform that was not annotated with `@Inject`** — which is nearly all of
 *     them.
 *
 * And the quieter cost: the 30 `test/app-module-graph.test.ts` boot guards
 * exist to prove each service's DI graph resolves. For a provider wired by bare
 * parameter type they could not — a genuinely unregistered provider was
 * invisible to them.
 *
 * **Why `ts.transpileModule` and not `@swc/core`.** swc is the conventional
 * answer and it is faster. It is also not on CLAUDE.md §13's approved list, and
 * §16 says to ask rather than reach for one. `typescript` is already a
 * devDependency of every workspace here, so this needs no new library at all —
 * it is the same mechanism `ts-jest` uses. The cost is compile speed, paid only
 * by the lanes that opt in.
 *
 * **Why a plain `.mjs` and not a compiled export.** A vitest config importing
 * this would otherwise need `packages/testing/dist` to be current, and
 * `test:integration` is run by hand with no `dependsOn: ["^build"]` in front of
 * it. A stale or missing `dist` would make the plugin silently absent — which
 * is exactly the failure it exists to prevent. Source with no build step cannot
 * be stale.
 *
 * **Why CommonJS.** These vitest configs are `.ts` in packages that declare no
 * `"type": "module"`, so Vite loads them through `require`. An ESM-only plugin
 * fails at config load with "ESM file cannot be loaded by `require`" — before
 * any test runs, which at least is loud.
 *
 * Usage, in a vitest config:
 *
 * ```ts
 * import { decoratorMetadata } from '@taste-and-see/testing/vitest-plugin';
 * export default defineConfig({ plugins: [decoratorMetadata()], test: { … } });
 * ```
 */

/**
 * Mirrors `packages/tsconfig/base.json`. Kept as a literal rather than read
 * from disk: `transpileModule` ignores most of a real tsconfig anyway (it has
 * no program and does no type resolution), so loading one would suggest a
 * fidelity this does not have. The options that matter are the four below the
 * target — everything else is here to keep the output shaped like the rest of
 * the pipeline's.
 */
const COMPILER_OPTIONS = {
  target: ts.ScriptTarget.ES2022,
  // ESNext: Vite consumes ES modules. Emitting CommonJS here would push every
  // file through Vite's interop layer for no benefit.
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  // The four that are the entire point.
  experimentalDecorators: true,
  emitDecoratorMetadata: true,
  useDefineForClassFields: true,
  esModuleInterop: true,
  allowSyntheticDefaultImports: true,
  resolveJsonModule: true,
  // `transpileModule` is per-file with no cross-file type information, so it is
  // always operating under isolated-modules rules whether or not this is set.
  // Saying so explicitly makes TypeScript report the cases it cannot handle
  // rather than guess at them.
  isolatedModules: true,
  verbatimModuleSyntax: false,
  importHelpers: false,
  sourceMap: true,
  inlineSources: true,
};

const TS_FILE = /\.tsx?$/;
const DECLARATION_FILE = /\.d\.tsx?$/;

/**
 * @param {{ include?: (id: string) => boolean }} [options]
 *   `include` narrows which modules are compiled by TypeScript. The default is
 *   every non-declaration `.ts`/`.tsx` outside `node_modules`. Narrowing it is
 *   a performance lever, not a correctness one — but note that narrowing to
 *   "only `src/**`" would be wrong for a test that declares a Nest provider of
 *   its own.
 */
function decoratorMetadata(options = {}) {
  const include =
    options.include ??
    ((id) => TS_FILE.test(id) && !DECLARATION_FILE.test(id) && !id.includes('node_modules'));

  return {
    name: 'taste-and-see:decorator-metadata',
    // Ahead of Vite's own esbuild transform, which would otherwise strip the
    // types (and the decorator metadata with them) before this ever runs.
    enforce: 'pre',

    transform(code, id) {
      // Vite appends `?v=…` and similar to module ids.
      const file = id.split('?')[0];
      if (file === undefined || !include(file)) return null;

      const output = ts.transpileModule(code ?? readFileSync(file, 'utf8'), {
        fileName: file,
        compilerOptions: COMPILER_OPTIONS,
        reportDiagnostics: true,
      });

      // `transpileModule` reports only syntactic and option diagnostics — it
      // cannot type-check — so anything here is a real problem with the file or
      // the options above, not a type error the lane should be tolerating.
      // Swallowing them would reintroduce the class of silence this plugin
      // exists to end.
      const fatal = (output.diagnostics ?? []).filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      );
      if (fatal.length > 0) {
        const detail = fatal
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
          .join('; ');
        throw new Error(`[decorator-metadata] ${file}: ${detail}`);
      }

      return {
        code: output.outputText,
        map: output.sourceMapText === undefined ? null : JSON.parse(output.sourceMapText),
      };
    },
  };
}

module.exports = { decoratorMetadata };
module.exports.default = decoratorMetadata;
