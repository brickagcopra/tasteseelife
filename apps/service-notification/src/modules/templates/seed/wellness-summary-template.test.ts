import {
  WELLNESS_SUMMARY_TEMPLATE_CODE,
  WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES,
} from '@taste-and-see/contracts';
import { describe, expect, it, vi } from 'vitest';

import { MjmlCompilerService } from '../services/mjml-compiler.service';

import {
  buildWellnessSummaryTemplateSeed,
  seedWellnessSummaryTemplate,
} from './wellness-summary-template';

describe('buildWellnessSummaryTemplateSeed', () => {
  const seed = buildWellnessSummaryTemplateSeed();

  it('targets the shared template code, en_US, email kind', () => {
    expect(seed.code).toBe(WELLNESS_SUMMARY_TEMPLATE_CODE);
    expect(seed.dbLocale).toBe('en_US');
    expect(seed.kind).toBe('email');
  });

  it('declares exactly the shared contract variable set', () => {
    expect(seed.variablesSchema.map((v) => v.name)).toEqual([
      ...WELLNESS_SUMMARY_TEMPLATE_VARIABLE_NAMES,
    ]);
  });

  it('references every declared variable in the subject or one of the bodies', () => {
    const haystack = `${seed.subject}\n${seed.bodyMjml}\n${seed.bodyText}`;
    for (const { name } of seed.variablesSchema) {
      expect(haystack, `template never references {{${name}}}`).toContain(name);
    }
  });

  it('compiles its MJML body without errors', () => {
    const result = new MjmlCompilerService().compile(seed.bodyMjml);
    expect(result.outcome).toBe('ok');
  });
});

/**
 * Fake Prisma surface for the seed — only the four calls the seed makes.
 * Each test wires the responses + records the writes.
 */
function makeFakePrisma(opts: {
  existing: { id: string; activeVersionId: string | null } | null;
  headVersion: number | null;
}) {
  const calls = { created: 0, versionCreated: 0, activated: 0 };
  let createdVersion: { id: string; version: number } | null = null;
  const tx = {
    notificationTemplate: {
      create: vi.fn(async () => {
        calls.created += 1;
        return { id: 'tpl_new', activeVersionId: null };
      }),
      update: vi.fn(async () => {
        calls.activated += 1;
        return {};
      }),
    },
    notificationTemplateVersion: {
      findFirst: vi.fn(async () =>
        opts.headVersion === null ? null : { version: opts.headVersion },
      ),
      create: vi.fn(async () => {
        calls.versionCreated += 1;
        createdVersion = { id: 'ver_1', version: (opts.headVersion ?? 0) + 1 };
        return createdVersion;
      }),
    },
  };
  const prisma = {
    notificationTemplate: {
      findUnique: vi.fn(async () => opts.existing),
    },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx, calls };
}

describe('seedWellnessSummaryTemplate', () => {
  const mjml = new MjmlCompilerService();

  it('creates the template + activates version 1 when nothing exists', async () => {
    const { prisma, tx, calls } = makeFakePrisma({ existing: null, headVersion: null });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const report = await seedWellnessSummaryTemplate(prisma as any, mjml);

    expect(report.outcome).toBe('created');
    expect(report.version).toBe(1);
    expect(calls).toEqual({ created: 1, versionCreated: 1, activated: 1 });
    expect(tx.notificationTemplateVersion.create).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when the template already has an active version', async () => {
    const { prisma, calls } = makeFakePrisma({
      existing: { id: 'tpl_1', activeVersionId: 'ver_active' },
      headVersion: 1,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const report = await seedWellnessSummaryTemplate(prisma as any, mjml);

    expect(report.outcome).toBe('already_active');
    expect(report.version).toBeNull();
    expect(calls).toEqual({ created: 0, versionCreated: 0, activated: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('activates a fresh version when the template exists without one', async () => {
    const { prisma, tx, calls } = makeFakePrisma({
      existing: { id: 'tpl_1', activeVersionId: null },
      headVersion: 2,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural fake
    const report = await seedWellnessSummaryTemplate(prisma as any, mjml);

    expect(report.outcome).toBe('activated_existing');
    expect(report.version).toBe(3);
    // existing template — no create, but a new version + activation
    expect(calls).toEqual({ created: 0, versionCreated: 1, activated: 1 });
    expect(tx.notificationTemplate.create).not.toHaveBeenCalled();
  });
});
