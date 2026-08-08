import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Every `HealthController` constructor parameter carries an explicit
 * `@Inject(...)`.
 *
 * **Why (TS-305d-followup-2b).** `service-provider`'s integration suite
 * answered `503` on `GET /readyz` against a live, migrated Postgres — while
 * the same test file read the `provider` schema through its own Prisma
 * client, in the same process, against the same database. The filed
 * hypothesis was the TS-141 tenant-scope gate. It was not. The cause was
 * `TypeError: Cannot read properties of undefined (reading 'ping')`: the
 * controller's `prisma` was **undefined**, because Nest resolves a bare
 * constructor parameter type through `design:paramtypes`, and vitest's
 * esbuild transform does not emit that metadata. `tsc` does
 * (`emitDecoratorMetadata` in `packages/tsconfig/base.json`), so the
 * production artifact was — and is — correct. Verified both ways: the built
 * `dist/health/health.controller.js` carries
 * `__metadata("design:paramtypes", [PrismaService, Object])`.
 *
 * **Why it is worth a standing guard even though production was fine.**
 *
 *   - Nest does not error on this. With no `design:paramtypes` it reads the
 *     class as having zero dependencies, merges in whatever
 *     `@Inject`-decorated indices exist, and constructs the class with a hole
 *     where the missing one belongs. There is no "cannot resolve dependency"
 *     message — the object is built, the route is mounted, and the failure
 *     surfaces later as a swallowed `TypeError` inside a `catch`.
 *   - Readiness is the endpoint where that is most expensive. A pod whose
 *     `/readyz` always 503s never joins its Service's endpoints: the workload
 *     deploys, reports healthy to the kubelet, and takes no traffic.
 *   - It made the integration lane assert the opposite of the truth. The
 *     suite existed to prove the health surface works end to end, and for as
 *     long as this stood it could only prove that it does not.
 *
 * **Scope, deliberately narrow.** This guard covers `health.controller.ts`
 * only. The same gap applies to every Nest provider on the platform under the
 * test lanes — annotating all of them is a much larger change and is filed as
 * TS-305d-followup-2b1. Health controllers are pulled forward because they are
 * the ones whose silent failure costs a workload its traffic, and because
 * their constructors are two parameters wide.
 *
 * **Why a source check.** The property is about what the compiler emits, so a
 * runtime assertion would be checking the very thing that differs between the
 * two compilers. Reading the decorator out of the source is what makes it hold
 * under both.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

/** `@Inject(TOKEN) private readonly name: Type,` — the shape we require. */
const INJECTED_PARAM = /^\s*@Inject\(/;
/** A constructor parameter line that declares a property but names no token. */
const BARE_PARAM = /^\s*(?:private|public|protected|readonly)\s/;

function healthControllers(dir: string): string[] {
  const found: string[] = [];
  // `apps/workers/` carries loose files beside the workload directories.
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return found;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') continue;
        walk(full);
        continue;
      }
      if (entry === 'health.controller.ts') found.push(full);
    }
  };
  walk(dir);
  return found;
}

/** Constructor parameters that rely on `design:paramtypes` to resolve. */
function bareConstructorParams(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const match = /^ {2}constructor\(\n([\s\S]*?)^ {2}\)/m.exec(source);
  // A health controller with no constructor has no dependencies to lose.
  if (match === null) return [];

  const relative = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
  return (match[1] as string)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => BARE_PARAM.test(line) && !INJECTED_PARAM.test(line))
    .map((line) => `${relative} → ${line.trim()}`);
}

describe('health controller injection (TS-305d-followup-2b)', () => {
  const files = [
    ...readdirSync(APPS_DIR)
      .filter((name) => name.startsWith('service-') || name === 'api-gateway')
      .map((name) => path.join(APPS_DIR, name, 'src')),
    ...readdirSync(path.join(APPS_DIR, 'workers')).map((name) =>
      path.join(APPS_DIR, 'workers', name, 'src'),
    ),
  ].flatMap((src) => healthControllers(src));

  it('discovers every workload health controller', () => {
    // Totality, the same posture as `service-ports.test.ts` and
    // `boot-graph-stub-env.test.ts`: a walker that stops finding files must
    // not be able to turn "no offenders" into "nothing was checked".
    expect(files.length).toBeGreaterThanOrEqual(30);
  });

  it('injects every health-controller dependency by explicit token', () => {
    const offenders = files.flatMap(bareConstructorParams);
    expect(
      offenders,
      'These parameters resolve through `design:paramtypes`, which tsc emits and ' +
        "vitest's esbuild does not — so under the test lanes they are `undefined` " +
        'and `/readyz` answers 503 against a healthy database. Add `@Inject(Type)`.\n' +
        offenders.join('\n'),
    ).toEqual([]);
  });

  it('logs the cause before turning a dependency failure into a 503', () => {
    // The second half of the same defect: every readiness probe caught the
    // throw and reported `postgres readiness check failed` with the real
    // error only in a `cause` field that `RfcProblemFilter` strips. The
    // 503 was correct and unactionable.
    const silent = files.filter((file) => {
      const source = readFileSync(file, 'utf8');
      if (!/\} catch/.test(source)) return false;
      return !source.includes('this.logger.error(');
    });
    expect(
      silent.map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/')),
      'A readiness probe that fails must say why — a pod that never joins its ' +
        "Service's endpoints is the failure least affordable to diagnose by guesswork.",
    ).toEqual([]);
  });
});
