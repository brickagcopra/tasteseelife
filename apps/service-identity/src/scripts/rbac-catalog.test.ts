import { RBAC_CATALOG_FORMAT_VERSION } from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  RbacCatalogImportRefusedError,
  RbacCatalogImportValidationError,
  type RbacCatalogImportPlan,
} from '../modules/rbac/rbac-catalog-port.service';
import { parseRbacCatalogArgs, runRbacCatalogCli, type RbacCatalogCliIo } from './rbac-catalog';

const EMPTY_PLAN: RbacCatalogImportPlan = {
  permissionsToCreate: [],
  permissionDescriptionUpdates: [],
  roleDiffs: [],
  unchangedRoles: [],
  warnings: [],
  systemRoleChanges: [],
  errors: [],
};

const VALID_ENVELOPE_JSON = JSON.stringify({
  formatVersion: RBAC_CATALOG_FORMAT_VERSION,
  exportedAt: '2026-07-02T12:00:00.000Z',
  permissions: [],
  roles: [],
});

function buildIo(
  overrides: Partial<RbacCatalogCliIo> = {},
  port: Partial<{
    exportCatalog: ReturnType<typeof vi.fn>;
    planImport: ReturnType<typeof vi.fn>;
    applyImport: ReturnType<typeof vi.fn>;
  }> = {},
): {
  io: RbacCatalogCliIo;
  out: string[];
  err: string[];
  written: Map<string, string>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const out: string[] = [];
  const err: string[] = [];
  const written = new Map<string, string>();
  const dispose = vi.fn(async () => {});
  const fullPort = {
    exportCatalog:
      port.exportCatalog ??
      vi.fn(async () => ({
        formatVersion: RBAC_CATALOG_FORMAT_VERSION,
        exportedAt: '2026-07-02T12:00:00.000Z',
        permissions: [],
        roles: [],
      })),
    planImport: port.planImport ?? vi.fn(async () => EMPTY_PLAN),
    applyImport:
      port.applyImport ??
      vi.fn(async () => ({ applied: false, plan: EMPTY_PLAN, report: null, auditedRoles: [] })),
  };
  const io: RbacCatalogCliIo = {
    readFile: (path) => {
      const content = written.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeFile: (path, content) => {
      written.set(path, content);
    },
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => new Date('2026-07-02T12:00:00.000Z'),
    createPort: async () => ({ port: fullPort, dispose }),
    ...overrides,
  };
  return { io, out, err, written, dispose };
}

describe('parseRbacCatalogArgs', () => {
  it('parses export with exactly one file', () => {
    expect(parseRbacCatalogArgs(['export', 'catalog.json'])).toEqual({
      kind: 'export',
      file: 'catalog.json',
    });
  });

  it('parses import with flags in any position', () => {
    expect(parseRbacCatalogArgs(['import', '--dry-run', 'c.json'])).toEqual({
      kind: 'import',
      file: 'c.json',
      dryRun: true,
      allowSystem: false,
    });
    expect(parseRbacCatalogArgs(['import', 'c.json', '--allow-system'])).toEqual({
      kind: 'import',
      file: 'c.json',
      dryRun: false,
      allowSystem: true,
    });
  });

  it('rejects usage errors: no command, unknown command, missing file, unknown or contradictory flags', () => {
    expect(parseRbacCatalogArgs([]).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['frobnicate']).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['export']).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['export', 'a.json', 'b.json']).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['export', '--allow-system', 'a.json']).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['import', '--frobnicate', 'a.json']).kind).toBe('usage');
    expect(parseRbacCatalogArgs(['import', '--dry-run', '--allow-system', 'a.json']).kind).toBe(
      'usage',
    );
  });
});

describe('runRbacCatalogCli', () => {
  it('usage errors exit 64 and print the usage block', async () => {
    const { io, err } = buildIo();
    expect(await runRbacCatalogCli([], io)).toBe(64);
    expect(err.some((l) => l.includes('Usage: rbac-catalog'))).toBe(true);
  });

  it('export writes the envelope JSON and exits 0', async () => {
    const { io, out, written, dispose } = buildIo();
    expect(await runRbacCatalogCli(['export', 'catalog.json'], io)).toBe(0);
    const content = written.get('catalog.json');
    expect(content).toBeDefined();
    expect(JSON.parse(content ?? '')).toMatchObject({
      formatVersion: RBAC_CATALOG_FORMAT_VERSION,
    });
    expect(out.some((l) => l.includes('exported'))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('import exits 1 on unreadable file, invalid JSON, and non-envelope JSON', async () => {
    const a = buildIo();
    expect(await runRbacCatalogCli(['import', 'missing.json'], a.io)).toBe(1);

    const b = buildIo();
    b.written.set('bad.json', 'not json {');
    expect(await runRbacCatalogCli(['import', 'bad.json'], b.io)).toBe(1);

    const c = buildIo();
    c.written.set('wrong.json', JSON.stringify({ formatVersion: 99 }));
    expect(await runRbacCatalogCli(['import', 'wrong.json'], c.io)).toBe(1);
    expect(c.err.some((l) => l.includes('not a valid catalog envelope'))).toBe(true);
  });

  it('import --dry-run renders the plan, applies nothing, exits 0 (1 when the plan has errors)', async () => {
    const applyImport = vi.fn();
    const planImport = vi.fn(async () => ({
      ...EMPTY_PLAN,
      permissionsToCreate: ['widget:read'],
      systemRoleChanges: ['super_admin'],
    }));
    const { io, out } = buildIo({}, { planImport, applyImport });
    io.writeFile('c.json', VALID_ENVELOPE_JSON);

    expect(await runRbacCatalogCli(['import', '--dry-run', 'c.json'], io)).toBe(0);
    expect(applyImport).not.toHaveBeenCalled();
    expect(out.some((l) => l.includes('CREATE   permission widget:read'))).toBe(true);
    expect(out.some((l) => l.includes('--allow-system'))).toBe(true);
    expect(out.some((l) => l.includes('nothing was written'))).toBe(true);

    const failing = buildIo(
      {},
      { planImport: vi.fn(async () => ({ ...EMPTY_PLAN, errors: ['bad role'] })), applyImport },
    );
    failing.io.writeFile('c.json', VALID_ENVELOPE_JSON);
    expect(await runRbacCatalogCli(['import', '--dry-run', 'c.json'], failing.io)).toBe(1);
  });

  it('import maps guardrail refusal to exit 2 and validation failure to exit 1', async () => {
    const refused = buildIo(
      {},
      {
        applyImport: vi.fn(async () => {
          throw new RbacCatalogImportRefusedError(['super_admin']);
        }),
      },
    );
    refused.io.writeFile('c.json', VALID_ENVELOPE_JSON);
    expect(await runRbacCatalogCli(['import', 'c.json'], refused.io)).toBe(2);
    expect(refused.err.some((l) => l.includes('REFUSED'))).toBe(true);

    const invalid = buildIo(
      {},
      {
        applyImport: vi.fn(async () => {
          throw new RbacCatalogImportValidationError(['role "x" is broken']);
        }),
      },
    );
    invalid.io.writeFile('c.json', VALID_ENVELOPE_JSON);
    expect(await runRbacCatalogCli(['import', 'c.json'], invalid.io)).toBe(1);
    expect(invalid.err.some((l) => l.includes('role "x" is broken'))).toBe(true);
  });

  it('import success renders the plan + apply summary and exits 0', async () => {
    const applyImport = vi.fn(async () => ({
      applied: true,
      plan: {
        ...EMPTY_PLAN,
        roleDiffs: [
          {
            name: 'widget_operator',
            kind: 'create' as const,
            isSystem: false,
            sensitive: false,
            descriptionChange: null,
            permissionsToAttach: ['widget:read'],
            permissionsToDetach: [],
          },
        ],
      },
      report: {
        permissionsUpserted: 1,
        rolesUpserted: 1,
        rolePermissionsAttached: 1,
        rolePermissionsDetached: 0,
        skippedUnknownPermissions: [],
      },
      auditedRoles: ['widget_operator'],
    }));
    const { io, out, dispose } = buildIo({}, { applyImport });
    io.writeFile('c.json', VALID_ENVELOPE_JSON);

    expect(await runRbacCatalogCli(['import', '--allow-system', 'c.json'], io)).toBe(0);
    expect(applyImport).toHaveBeenCalledWith(
      expect.objectContaining({ formatVersion: RBAC_CATALOG_FORMAT_VERSION }),
      expect.objectContaining({ allowSystem: true }),
    );
    expect(out.some((l) => l.includes('CREATE   role widget_operator'))).toBe(true);
    expect(out.some((l) => l.includes('applied — 1 role(s) changed'))).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
