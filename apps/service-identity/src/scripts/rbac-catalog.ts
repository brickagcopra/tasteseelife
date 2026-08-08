import 'reflect-metadata';

import { readFileSync, writeFileSync } from 'node:fs';

import { Logger } from '@nestjs/common';
import { RbacCatalogEnvelopeSchema } from '@taste-and-see/contracts';
import { AuditEmitter, SYSTEM_AUDIT_ACTOR } from '@taste-and-see/nest-audit';
import { OutboxService, validateOptions } from '@taste-and-see/nest-outbox';
import {
  TenantContextStore,
  runWithoutTenantContext,
} from '@taste-and-see/nest-prisma-tenant-scope';

import { loadEnv } from '../config/env';
import {
  RbacCatalogImportRefusedError,
  RbacCatalogImportValidationError,
  RbacCatalogPortService,
  type RbacCatalogImportPlan,
} from '../modules/rbac/rbac-catalog-port.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * RBAC catalog export/import CLI (TS-299; PRD §10.12; PDD §10.3).
 *
 * Usage:
 *
 *   pnpm -F @taste-and-see/service-identity rbac:catalog export <file>
 *   pnpm -F @taste-and-see/service-identity rbac:catalog import --dry-run <file>
 *   pnpm -F @taste-and-see/service-identity rbac:catalog import [--allow-system] <file>
 *
 * Exit codes: 0 ok · 1 error (bad file, validation failure, DB error)
 * · 2 refused by the system-role guardrail (re-run with
 * `--allow-system` if intentional) · 64 usage.
 *
 * `import --dry-run` prints the full reconciliation plan (creates /
 * attaches / detaches / warnings) and writes NOTHING — since role
 * definitions have no server-side approval flow, reviewing the dry-run
 * IS the review step. A real import runs in one transaction and emits
 * one `audit.action_recorded` per changed role under the system actor
 * (no HTTP session exists here — the operator identity is the Job /
 * shell audit trail, same posture as `seed:rbac`).
 *
 * Import is DELIBERATELY CLI-only — see
 * `rbac-catalog-port.service.ts` for why it has no HTTP endpoint.
 *
 * Like `seed-rbac.ts`, this script instantiates `PrismaService`
 * directly (no Nest DI, so the tenant-scope wrapper does not apply)
 * and still wraps its work in `runWithoutTenantContext` so the intent
 * stays explicit + future-proof.
 */

const USAGE = [
  'Usage: rbac-catalog <command>',
  '',
  'Commands:',
  '  export <file>                        Write the catalog envelope (JSON) to <file>',
  '  import --dry-run <file>              Print the reconciliation plan; write nothing',
  '  import [--allow-system] <file>       Apply the envelope (one transaction, audited)',
  '',
  'Flags:',
  '  --dry-run        Plan only — never combined with --allow-system (nothing is applied)',
  '  --allow-system   Permit changes to system / sensitive roles (super_admin, finance, …)',
].join('\n');

export type RbacCatalogCliCommand =
  | { readonly kind: 'export'; readonly file: string }
  | {
      readonly kind: 'import';
      readonly file: string;
      readonly dryRun: boolean;
      readonly allowSystem: boolean;
    }
  | { readonly kind: 'usage'; readonly problem: string | null };

/** Pure argv parser — testable without a database. */
export function parseRbacCatalogArgs(args: readonly string[]): RbacCatalogCliCommand {
  const [command, ...rest] = args;

  if (command === 'export') {
    const positional = rest.filter((a) => !a.startsWith('--'));
    const flags = rest.filter((a) => a.startsWith('--'));
    if (flags.length > 0) return usage(`export takes no flags (got ${flags.join(', ')})`);
    const file = positional[0];
    if (file === undefined || positional.length !== 1) {
      return usage('export requires exactly one <file> argument');
    }
    return { kind: 'export', file };
  }

  if (command === 'import') {
    const positional = rest.filter((a) => !a.startsWith('--'));
    const flags = rest.filter((a) => a.startsWith('--'));
    const unknownFlags = flags.filter((f) => f !== '--dry-run' && f !== '--allow-system');
    if (unknownFlags.length > 0) return usage(`unknown flag(s): ${unknownFlags.join(', ')}`);
    const file = positional[0];
    if (file === undefined || positional.length !== 1) {
      return usage('import requires exactly one <file> argument');
    }
    const dryRun = flags.includes('--dry-run');
    const allowSystem = flags.includes('--allow-system');
    if (dryRun && allowSystem) {
      return usage('--dry-run never applies anything — drop --allow-system');
    }
    return { kind: 'import', file, dryRun, allowSystem };
  }

  return usage(command === undefined ? null : `unknown command '${command}'`);
}

function usage(problem: string | null): RbacCatalogCliCommand {
  return { kind: 'usage', problem };
}

/**
 * Injected side-effect surface so the dispatcher is unit-testable
 * without a live database (mirrors the contracts CLI's factoring).
 */
export interface RbacCatalogCliIo {
  readonly readFile: (path: string) => string;
  readonly writeFile: (path: string, content: string) => void;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly now: () => Date;
  /** Open a connected port service; `dispose` closes the connection. */
  readonly createPort: () => Promise<{
    readonly port: Pick<RbacCatalogPortService, 'exportCatalog' | 'planImport' | 'applyImport'>;
    readonly dispose: () => Promise<void>;
  }>;
}

/** Command dispatcher. Returns the process exit code. */
export async function runRbacCatalogCli(
  args: readonly string[],
  io: RbacCatalogCliIo,
): Promise<number> {
  const command = parseRbacCatalogArgs(args);

  if (command.kind === 'usage') {
    if (command.problem !== null) io.stderr(`rbac-catalog: ${command.problem}`);
    io.stderr(USAGE);
    return 64;
  }

  if (command.kind === 'export') {
    const handle = await io.createPort();
    try {
      const envelope = await handle.port.exportCatalog(io.now());
      io.writeFile(command.file, `${JSON.stringify(envelope, null, 2)}\n`);
      io.stdout(
        `rbac-catalog: exported ${envelope.permissions.length} permissions, ${envelope.roles.length} roles → ${command.file}`,
      );
      return 0;
    } finally {
      await handle.dispose();
    }
  }

  // ── import ──
  let raw: string;
  try {
    raw = io.readFile(command.file);
  } catch (err) {
    io.stderr(
      `rbac-catalog: cannot read ${command.file}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    io.stderr(`rbac-catalog: ${command.file} is not valid JSON`);
    return 1;
  }
  const parsed = RbacCatalogEnvelopeSchema.safeParse(json);
  if (!parsed.success) {
    io.stderr(`rbac-catalog: ${command.file} is not a valid catalog envelope:`);
    for (const issue of parsed.error.issues) {
      io.stderr(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
    return 1;
  }

  const handle = await io.createPort();
  try {
    if (command.dryRun) {
      const plan = await handle.port.planImport(parsed.data);
      renderPlan(plan, io.stdout);
      if (plan.errors.length > 0) {
        io.stderr(
          'rbac-catalog: dry-run found validation errors (see above) — an import would fail',
        );
        return 1;
      }
      if (plan.systemRoleChanges.length > 0) {
        io.stdout(
          `rbac-catalog: NOTE — this import alters system role(s) [${plan.systemRoleChanges.join(', ')}] and will require --allow-system`,
        );
      }
      io.stdout('rbac-catalog: dry-run complete — nothing was written');
      return 0;
    }

    try {
      const result = await handle.port.applyImport(parsed.data, {
        allowSystem: command.allowSystem,
        actor: SYSTEM_AUDIT_ACTOR,
      });
      renderPlan(result.plan, io.stdout);
      if (!result.applied) {
        io.stdout('rbac-catalog: catalog already in sync — nothing to apply');
        return 0;
      }
      io.stdout(
        `rbac-catalog: applied — ${result.auditedRoles.length} role(s) changed [${result.auditedRoles.join(', ')}], ` +
          `${result.report?.rolePermissionsAttached ?? 0} attached, ${result.report?.rolePermissionsDetached ?? 0} detached`,
      );
      return 0;
    } catch (err) {
      if (err instanceof RbacCatalogImportValidationError) {
        io.stderr('rbac-catalog: import failed validation:');
        for (const e of err.errors) io.stderr(`  - ${e}`);
        return 1;
      }
      if (err instanceof RbacCatalogImportRefusedError) {
        io.stderr(`rbac-catalog: REFUSED — ${err.message}`);
        return 2;
      }
      throw err;
    }
  } finally {
    await handle.dispose();
  }
}

function renderPlan(plan: RbacCatalogImportPlan, out: (line: string) => void): void {
  for (const e of plan.errors) out(`ERROR    ${e}`);
  for (const key of plan.permissionsToCreate) out(`CREATE   permission ${key}`);
  for (const key of plan.permissionDescriptionUpdates)
    out(`UPDATE   permission ${key} (description)`);
  for (const diff of plan.roleDiffs) {
    const tags = [diff.isSystem ? 'SYSTEM' : null, diff.sensitive ? 'SENSITIVE' : null]
      .filter((t): t is string => t !== null)
      .join(' ');
    out(
      `${diff.kind === 'create' ? 'CREATE' : 'UPDATE'}   role ${diff.name}${tags.length > 0 ? ` [${tags}]` : ''}`,
    );
    if (diff.descriptionChange !== null) {
      out(
        `           description: ${JSON.stringify(diff.descriptionChange.from)} → ${JSON.stringify(diff.descriptionChange.to)}`,
      );
    }
    for (const p of diff.permissionsToAttach) out(`           + ${p}`);
    for (const p of diff.permissionsToDetach) out(`           - ${p}`);
  }
  for (const name of plan.unchangedRoles) out(`OK       role ${name} (unchanged)`);
  for (const w of plan.warnings) out(`WARN     ${w}`);
}

/** Wire the real side effects and run. */
async function main(): Promise<number> {
  loadEnv();
  const cliLogger = new Logger('rbac-catalog');

  const io: RbacCatalogCliIo = {
    readFile: (path) => readFileSync(path, 'utf8'),
    writeFile: (path, content) => {
      writeFileSync(path, content, 'utf8');
    },
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    now: () => new Date(),
    createPort: async () => {
      const prisma = new PrismaService();
      const tenantStore = new TenantContextStore();
      await prisma.$connect();
      const outbox = new OutboxService(
        validateOptions({ serviceName: 'service-identity', schemaName: 'identity' }),
      );
      const port = new RbacCatalogPortService(prisma, new AuditEmitter(outbox, 'service-identity'));
      return {
        port: {
          exportCatalog: (now) =>
            runWithoutTenantContext(tenantStore, 'rbac-catalog', () => port.exportCatalog(now)),
          planImport: (envelope) =>
            runWithoutTenantContext(tenantStore, 'rbac-catalog', () => port.planImport(envelope)),
          applyImport: (envelope, options) =>
            runWithoutTenantContext(tenantStore, 'rbac-catalog', () =>
              port.applyImport(envelope, options),
            ),
        },
        dispose: async () => {
          await prisma.$disconnect();
        },
      };
    },
  };

  try {
    return await runRbacCatalogCli(process.argv.slice(2), io);
  } catch (err) {
    cliLogger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'rbac-catalog failed',
    );
    return 1;
  }
}

// eslint-disable-next-line no-undef
if (require.main === module) {
  void main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
