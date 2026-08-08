import { describe, expect, it } from 'vitest';

import { HandlebarsRendererService } from './handlebars-renderer.service';
import { MjmlCompilerService } from './mjml-compiler.service';
import { TemplatesService } from './templates.service';
import { VariableValidatorService } from './variable-validator.service';
import type { PrismaService } from '../../../prisma/prisma.service';

interface FakeTemplateRow {
  id: string;
  code: string;
  locale: 'en_US' | 'es_US' | 'zh_CN';
  kind: 'email' | 'sms' | 'push' | 'in_app';
  name: string;
  description: string | null;
  activeVersionId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeVersionRow {
  id: string;
  templateId: string;
  kind: 'email' | 'sms' | 'push' | 'in_app';
  version: number;
  subject: string | null;
  bodyMjml: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  variablesSchema: unknown;
  changeSummary: string | null;
  createdByUserId: string;
  createdAt: Date;
}

/**
 * In-memory FakePrisma for TemplatesService unit tests. Implements
 * only the methods the service actually calls; the type assertion to
 * `PrismaService` is the trade-off for not pulling testcontainers
 * into the unit suite. The integration suite (TS-072-followup-5) will
 * exercise the real Prisma client against a Postgres container.
 */
class FakePrisma {
  templates: FakeTemplateRow[] = [];
  versions: FakeVersionRow[] = [];
  private nextId = 1;

  private id(prefix: string): string {
    const out = `${prefix}_${String(this.nextId).padStart(6, '0')}`;
    this.nextId += 1;
    return out;
  }

  notificationTemplate = {
    create: async ({
      data,
    }: {
      data: {
        code: string;
        locale: 'en_US' | 'es_US' | 'zh_CN';
        kind: 'email' | 'sms' | 'push' | 'in_app';
        name: string;
        description: string | null;
        createdByUserId: string;
      };
    }): Promise<FakeTemplateRow> => {
      const existing = this.templates.find((t) => t.code === data.code && t.locale === data.locale);
      if (existing !== undefined) {
        const err = new Error('unique constraint') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const now = new Date();
      const row: FakeTemplateRow = {
        id: this.id('tpl'),
        code: data.code,
        locale: data.locale,
        kind: data.kind,
        name: data.name,
        description: data.description,
        activeVersionId: null,
        createdByUserId: data.createdByUserId,
        createdAt: now,
        updatedAt: now,
      };
      this.templates.push(row);
      return row;
    },

    findUnique: async ({
      where,
      include,
    }: {
      where: { id?: string; code_locale?: { code: string; locale: 'en_US' | 'es_US' | 'zh_CN' } };
      include?: {
        activeVersion?: boolean | { select?: { version?: boolean } };
        versions?: {
          orderBy?: { version: 'desc' | 'asc' };
          select?: { version?: boolean };
          take?: number;
        };
      };
      select?: { activeVersionId?: boolean };
    }): Promise<unknown> => {
      let row: FakeTemplateRow | undefined;
      if (where.id !== undefined) {
        row = this.templates.find((t) => t.id === where.id);
      } else if (where.code_locale !== undefined) {
        const cl = where.code_locale;
        row = this.templates.find((t) => t.code === cl.code && t.locale === cl.locale);
      }
      if (row === undefined) return null;

      if (include === undefined) return row;

      const enriched: Record<string, unknown> = { ...row };
      if (include.activeVersion !== undefined) {
        if (row.activeVersionId === null) {
          enriched['activeVersion'] = null;
        } else {
          const active = this.versions.find((v) => v.id === row.activeVersionId);
          enriched['activeVersion'] = active !== undefined ? { ...active } : null;
        }
      }
      if (include.versions !== undefined) {
        const desc = include.versions.orderBy?.version === 'desc';
        let list = this.versions.filter((v) => v.templateId === row.id);
        list = desc
          ? list.sort((a, b) => b.version - a.version)
          : list.sort((a, b) => a.version - b.version);
        if (include.versions.take !== undefined) {
          list = list.slice(0, include.versions.take);
        }
        enriched['versions'] = list.map((v) => ({ version: v.version }));
      }
      return enriched;
    },

    findMany: async ({
      where,
      orderBy: _orderBy,
      take,
      include,
    }: {
      where?: {
        kind?: 'email' | 'sms' | 'push' | 'in_app';
        locale?: 'en_US' | 'es_US' | 'zh_CN';
        code?: string;
        OR?: ReadonlyArray<
          { createdAt: { lt: Date } } | { createdAt: { equals: Date }; id: { lt: string } }
        >;
      };
      orderBy?: ReadonlyArray<{ createdAt?: 'desc'; id?: 'desc' }>;
      take?: number;
      include?: {
        activeVersion?: boolean | { select?: { version?: boolean } };
        versions?: {
          orderBy?: { version: 'desc' | 'asc' };
          select?: { version?: boolean };
          take?: number;
        };
      };
    } = {}): Promise<unknown[]> => {
      let list = [...this.templates];
      if (where !== undefined) {
        if (where.kind !== undefined) {
          list = list.filter((t) => t.kind === where.kind);
        }
        if (where.locale !== undefined) {
          list = list.filter((t) => t.locale === where.locale);
        }
        if (where.code !== undefined) {
          list = list.filter((t) => t.code === where.code);
        }
        if (where.OR !== undefined) {
          list = list.filter((t) =>
            where.OR!.some((clause) => {
              if ('createdAt' in clause && 'id' in clause) {
                return (
                  t.createdAt.getTime() === clause.createdAt.equals.getTime() && t.id < clause.id.lt
                );
              }
              return t.createdAt.getTime() < clause.createdAt.lt.getTime();
            }),
          );
        }
      }
      // orderBy: createdAt desc, id desc.
      list.sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t !== 0 ? t : b.id.localeCompare(a.id);
      });
      if (take !== undefined) {
        list = list.slice(0, take);
      }
      if (include === undefined) return list;

      return list.map((row) => {
        const enriched: Record<string, unknown> = { ...row };
        if (include.activeVersion !== undefined) {
          if (row.activeVersionId === null) {
            enriched['activeVersion'] = null;
          } else {
            const active = this.versions.find((v) => v.id === row.activeVersionId);
            enriched['activeVersion'] = active !== undefined ? { version: active.version } : null;
          }
        }
        if (include.versions !== undefined) {
          const desc = include.versions.orderBy?.version === 'desc';
          let vlist = this.versions.filter((v) => v.templateId === row.id);
          vlist = desc
            ? vlist.sort((a, b) => b.version - a.version)
            : vlist.sort((a, b) => a.version - b.version);
          if (include.versions.take !== undefined) {
            vlist = vlist.slice(0, include.versions.take);
          }
          enriched['versions'] = vlist.map((v) => ({ version: v.version }));
        }
        return enriched;
      });
    },

    update: async ({
      where,
      data,
    }: {
      where: { id: string };
      data: { activeVersionId?: string };
    }): Promise<FakeTemplateRow> => {
      const row = this.templates.find((t) => t.id === where.id);
      if (row === undefined) {
        throw new Error('template not found');
      }
      if (data.activeVersionId !== undefined) {
        row.activeVersionId = data.activeVersionId;
      }
      row.updatedAt = new Date();
      return row;
    },
  };

  notificationTemplateVersion = {
    findFirst: async ({
      where,
      orderBy: _orderBy,
      select: _select,
    }: {
      where: { templateId: string; version?: number };
      orderBy?: { version: 'desc' | 'asc' };
      select?: { version?: boolean; chainHash?: boolean };
    }): Promise<FakeVersionRow | { version: number } | null> => {
      let list = this.versions.filter((v) => v.templateId === where.templateId);
      if (where.version !== undefined) {
        list = list.filter((v) => v.version === where.version);
      }
      list.sort((a, b) => b.version - a.version);
      const head = list[0];
      return head ?? null;
    },

    create: async ({
      data,
    }: {
      data: {
        templateId: string;
        kind: 'email' | 'sms' | 'push' | 'in_app';
        version: number;
        subject: string | null;
        bodyMjml: string | null;
        bodyHtml: string | null;
        bodyText: string | null;
        variablesSchema: unknown;
        changeSummary: string | null;
        createdByUserId: string;
      };
    }): Promise<FakeVersionRow> => {
      const existing = this.versions.find(
        (v) => v.templateId === data.templateId && v.version === data.version,
      );
      if (existing !== undefined) {
        const err = new Error('unique constraint') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      const row: FakeVersionRow = {
        id: this.id('ver'),
        templateId: data.templateId,
        kind: data.kind,
        version: data.version,
        subject: data.subject,
        bodyMjml: data.bodyMjml,
        bodyHtml: data.bodyHtml,
        bodyText: data.bodyText,
        variablesSchema: data.variablesSchema,
        changeSummary: data.changeSummary,
        createdByUserId: data.createdByUserId,
        createdAt: new Date(),
      };
      this.versions.push(row);
      return row;
    },

    findMany: async ({
      where,
      orderBy: _orderBy,
    }: {
      where: { templateId: string };
      orderBy?: { version: 'desc' | 'asc' };
    }): Promise<FakeVersionRow[]> => {
      return this.versions
        .filter((v) => v.templateId === where.templateId)
        .sort((a, b) => b.version - a.version);
    },
  };

  // The service uses $transaction with a callback. We simulate by
  // invoking the callback with `this` as the tx client — every method
  // is idempotent and we don't model ROLLBACK in the fake.
  async $transaction<T>(cb: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return cb(this);
  }
}

function buildSvc(): { svc: TemplatesService; prisma: FakePrisma } {
  const prisma = new FakePrisma();
  const svc = new TemplatesService(
    prisma as unknown as PrismaService,
    new MjmlCompilerService(),
    new HandlebarsRendererService(),
    new VariableValidatorService(),
  );
  return { svc, prisma };
}

// ─── createTemplate ─────────────────────────────────────────────────────

describe('TemplatesService.createTemplate', () => {
  it('persists a new template and returns the row', async () => {
    const { svc, prisma } = buildSvc();
    const result = await svc.createTemplate({
      code: 'welcome.family.tier_2',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome — Tier 2',
      description: 'First-activation welcome.',
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.template.code).toBe('welcome.family.tier_2');
      expect(result.template.locale).toBe('en-US');
      expect(result.template.kind).toBe('email');
      expect(result.template.activeVersionId).toBeNull();
    }
    expect(prisma.templates.length).toBe(1);
  });

  it('returns code_locale_conflict on duplicate (code, locale)', async () => {
    const { svc } = buildSvc();
    await svc.createTemplate({
      code: 'welcome.family.tier_2',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    const dup = await svc.createTemplate({
      code: 'welcome.family.tier_2',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_002',
    });
    expect(dup.outcome).toBe('failed');
    if (dup.outcome === 'failed') {
      expect(dup.failure.kind).toBe('code_locale_conflict');
    }
  });

  it('allows the same code in a different locale', async () => {
    const { svc, prisma } = buildSvc();
    await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'EN Welcome',
      createdByUserId: 'user_001',
    });
    const other = await svc.createTemplate({
      code: 'welcome',
      locale: 'es-US',
      kind: 'email',
      name: 'ES Welcome',
      createdByUserId: 'user_001',
    });
    expect(other.outcome).toBe('ok');
    expect(prisma.templates.length).toBe(2);
  });
});

// ─── createVersion ──────────────────────────────────────────────────────

describe('TemplatesService.createVersion', () => {
  async function seedEmail(): Promise<{
    svc: TemplatesService;
    prisma: FakePrisma;
    templateId: string;
  }> {
    const built = buildSvc();
    const result = await built.svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (result.outcome !== 'ok') throw new Error('seed failed');
    return { ...built, templateId: result.template.id };
  }

  it('inserts the first version with version=1', async () => {
    const { svc, prisma, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      subject: 'Welcome',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [{ name: 'firstName', type: 'string', required: true }],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.version.version).toBe(1);
      expect(result.version.bodyHtml).toContain('{{firstName}}');
      expect(result.version.isActive).toBe(false);
    }
    expect(prisma.versions.length).toBe(1);
  });

  it('increments version on subsequent inserts', async () => {
    const { svc, templateId } = await seedEmail();
    await svc.createVersion({
      templateId,
      subject: 'V1',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v1</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    const v2 = await svc.createVersion({
      templateId,
      subject: 'V2',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v2</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(v2.outcome).toBe('ok');
    if (v2.outcome === 'ok') {
      expect(v2.version.version).toBe(2);
    }
  });

  it('activates the version in the same transaction when activate=true', async () => {
    const { svc, prisma, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      subject: 'Welcome',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: true,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.version.isActive).toBe(true);
    }
    const tpl = prisma.templates[0];
    expect(tpl?.activeVersionId).not.toBeNull();
  });

  it('returns template_not_found when the template id is unknown', async () => {
    const { svc } = buildSvc();
    const result = await svc.createVersion({
      templateId: 'tpl_doesnotexist',
      subject: 'Welcome',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('template_not_found');
    }
  });

  it('returns invalid_body_shape when email is missing subject', async () => {
    const { svc, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_body_shape');
    }
  });

  it('returns invalid_body_shape when email is missing body', async () => {
    const { svc, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      subject: 'Welcome',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_body_shape');
    }
  });

  it('returns invalid_body_shape when sms carries a subject', async () => {
    const built = buildSvc();
    const seed = await built.svc.createTemplate({
      code: 'mfa.code.sms',
      locale: 'en-US',
      kind: 'sms',
      name: 'SMS code',
      createdByUserId: 'user_001',
    });
    if (seed.outcome !== 'ok') throw new Error('seed failed');
    const result = await built.svc.createVersion({
      templateId: seed.template.id,
      subject: 'should not have subject',
      bodyText: 'Your code is {{code}}.',
      variablesSchema: [{ name: 'code', type: 'string', required: true }],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('invalid_body_shape');
    }
  });

  it('accepts an sms version with just bodyText', async () => {
    const built = buildSvc();
    const seed = await built.svc.createTemplate({
      code: 'mfa.code.sms',
      locale: 'en-US',
      kind: 'sms',
      name: 'SMS code',
      createdByUserId: 'user_001',
    });
    if (seed.outcome !== 'ok') throw new Error('seed failed');
    const result = await built.svc.createVersion({
      templateId: seed.template.id,
      bodyText: 'Your code is {{code}}.',
      variablesSchema: [{ name: 'code', type: 'string', required: true }],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('ok');
  });

  it('compiles MJML to HTML at version-create time and persists the compiled output', async () => {
    const { svc, prisma, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      subject: 'Welcome',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [{ name: 'firstName', type: 'string', required: true }],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('ok');
    const persisted = prisma.versions[0];
    expect(persisted?.bodyHtml).toBeTruthy();
    expect(persisted?.bodyHtml).toContain('{{firstName}}');
    // The original MJML source is retained for round-trip editing.
    expect(persisted?.bodyMjml).toContain('<mjml>');
  });

  it('returns mjml_compilation_failed on a bad MJML body', async () => {
    const { svc, templateId } = await seedEmail();
    const result = await svc.createVersion({
      templateId,
      subject: 'Welcome',
      bodyMjml: '<mjml><mj-body><mj-not-a-real-tag /></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('mjml_compilation_failed');
    }
  });
});

// ─── activateVersion ────────────────────────────────────────────────────

describe('TemplatesService.activateVersion', () => {
  it('flips the active pointer to the named version', async () => {
    const { svc, prisma } = buildSvc();
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'V1',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v1</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    const result = await svc.activateVersion({
      templateId: tpl.template.id,
      version: 1,
      actorUserId: 'user_002',
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.version.isActive).toBe(true);
    }
    const persisted = prisma.templates[0];
    expect(persisted?.activeVersionId).not.toBeNull();
  });

  it('returns version_not_found when the version is unknown', async () => {
    const { svc } = buildSvc();
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    const result = await svc.activateVersion({
      templateId: tpl.template.id,
      version: 99,
      actorUserId: 'user_001',
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('version_not_found');
    }
  });
});

// ─── render ─────────────────────────────────────────────────────────────

describe('TemplatesService.render', () => {
  async function seedActiveEmail(svc: TemplatesService): Promise<string> {
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'Welcome {{firstName}}',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi {{firstName}}</mj-text></mj-column></mj-section></mj-body></mjml>',
      bodyText: 'Hi {{firstName}}',
      variablesSchema: [{ name: 'firstName', type: 'string', required: true }],
      activate: true,
      createdByUserId: 'user_001',
    });
    return tpl.template.id;
  }

  it('renders subject + html + text for an email with variables', async () => {
    const { svc } = buildSvc();
    await seedActiveEmail(svc);
    const result = await svc.render({
      templateCode: 'welcome',
      locale: 'en-US',
      variables: { firstName: 'Alice' },
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.rendered.subject).toBe('Welcome Alice');
      expect(result.rendered.bodyText).toBe('Hi Alice');
      expect(result.rendered.bodyHtml).toContain('Hi Alice');
      expect(result.rendered.kind).toBe('email');
      expect(result.rendered.version).toBe(1);
    }
  });

  it('returns template_or_active_version_not_found when the code is unknown', async () => {
    const { svc } = buildSvc();
    const result = await svc.render({
      templateCode: 'unknown',
      locale: 'en-US',
      variables: {},
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('template_or_active_version_not_found');
    }
  });

  it('returns template_or_active_version_not_found when the template has no active version', async () => {
    const { svc } = buildSvc();
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'Welcome',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>Hi</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    const result = await svc.render({
      templateCode: 'welcome',
      locale: 'en-US',
      variables: {},
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('template_or_active_version_not_found');
    }
  });

  it('returns variable_validation_failed when a required variable is missing', async () => {
    const { svc } = buildSvc();
    await seedActiveEmail(svc);
    const result = await svc.render({
      templateCode: 'welcome',
      locale: 'en-US',
      variables: {},
    });
    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.kind).toBe('variable_validation_failed');
      if (result.failure.kind === 'variable_validation_failed') {
        expect(result.failure.issues[0]?.kind).toBe('missing_required');
      }
    }
  });

  it('HTML-escapes a variable in bodyHtml but not in bodyText', async () => {
    const { svc } = buildSvc();
    await seedActiveEmail(svc);
    const result = await svc.render({
      templateCode: 'welcome',
      locale: 'en-US',
      variables: { firstName: '<Alice>' },
    });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.rendered.bodyText).toBe('Hi <Alice>');
      expect(result.rendered.bodyHtml).toContain('&lt;Alice&gt;');
      expect(result.rendered.bodyHtml).not.toContain('<Alice>');
    }
  });

  it('renders different content per locale for the same code', async () => {
    const { svc } = buildSvc();
    const en = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'sms',
      name: 'EN Welcome',
      createdByUserId: 'user_001',
    });
    const es = await svc.createTemplate({
      code: 'welcome',
      locale: 'es-US',
      kind: 'sms',
      name: 'ES Welcome',
      createdByUserId: 'user_001',
    });
    if (en.outcome !== 'ok' || es.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: en.template.id,
      bodyText: 'Hi {{firstName}}',
      variablesSchema: [{ name: 'firstName', type: 'string', required: true }],
      activate: true,
      createdByUserId: 'user_001',
    });
    await svc.createVersion({
      templateId: es.template.id,
      bodyText: 'Hola {{firstName}}',
      variablesSchema: [{ name: 'firstName', type: 'string', required: true }],
      activate: true,
      createdByUserId: 'user_001',
    });
    const enResult = await svc.render({
      templateCode: 'welcome',
      locale: 'en-US',
      variables: { firstName: 'Alice' },
    });
    const esResult = await svc.render({
      templateCode: 'welcome',
      locale: 'es-US',
      variables: { firstName: 'Alice' },
    });
    if (enResult.outcome === 'ok' && esResult.outcome === 'ok') {
      expect(enResult.rendered.bodyText).toBe('Hi Alice');
      expect(esResult.rendered.bodyText).toBe('Hola Alice');
    }
  });
});

// ─── getTemplateById / listTemplates / listVersions ─────────────────────

describe('TemplatesService.getTemplateById', () => {
  it('returns the template + active/latest version counts', async () => {
    const { svc } = buildSvc();
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'V1',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v1</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: true,
      createdByUserId: 'user_001',
    });
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'V2',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v2</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    const result = await svc.getTemplateById(tpl.template.id);
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.template.activeVersionNumber).toBe(1);
      expect(result.template.latestVersionNumber).toBe(2);
    }
  });

  it('returns template_not_found for an unknown id', async () => {
    const { svc } = buildSvc();
    const result = await svc.getTemplateById('tpl_does_not_exist');
    expect(result.outcome).toBe('failed');
  });
});

describe('TemplatesService.listTemplates', () => {
  it('returns the full list when no filters are applied', async () => {
    const { svc } = buildSvc();
    await svc.createTemplate({
      code: 'a',
      locale: 'en-US',
      kind: 'email',
      name: 'A',
      createdByUserId: 'user_001',
    });
    await svc.createTemplate({
      code: 'b',
      locale: 'en-US',
      kind: 'sms',
      name: 'B',
      createdByUserId: 'user_001',
    });
    const result = await svc.listTemplates({ limit: 10 });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.templates.length).toBe(2);
      expect(result.nextCursor).toBeNull();
    }
  });

  it('filters by kind', async () => {
    const { svc } = buildSvc();
    await svc.createTemplate({
      code: 'a',
      locale: 'en-US',
      kind: 'email',
      name: 'A',
      createdByUserId: 'user_001',
    });
    await svc.createTemplate({
      code: 'b',
      locale: 'en-US',
      kind: 'sms',
      name: 'B',
      createdByUserId: 'user_001',
    });
    const result = await svc.listTemplates({ kind: 'sms', limit: 10 });
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.templates.length).toBe(1);
      expect(result.templates[0]?.code).toBe('b');
    }
  });
});

describe('TemplatesService.listVersions', () => {
  it('returns versions newest-first with isActive accurate', async () => {
    const { svc } = buildSvc();
    const tpl = await svc.createTemplate({
      code: 'welcome',
      locale: 'en-US',
      kind: 'email',
      name: 'Welcome',
      createdByUserId: 'user_001',
    });
    if (tpl.outcome !== 'ok') throw new Error('seed failed');
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'V1',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v1</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: false,
      createdByUserId: 'user_001',
    });
    await svc.createVersion({
      templateId: tpl.template.id,
      subject: 'V2',
      bodyMjml:
        '<mjml><mj-body><mj-section><mj-column><mj-text>v2</mj-text></mj-column></mj-section></mj-body></mjml>',
      variablesSchema: [],
      activate: true,
      createdByUserId: 'user_001',
    });
    const result = await svc.listVersions(tpl.template.id);
    expect(result.outcome).toBe('ok');
    if (result.outcome === 'ok') {
      expect(result.versions.length).toBe(2);
      expect(result.versions[0]?.version).toBe(2);
      expect(result.versions[0]?.isActive).toBe(true);
      expect(result.versions[1]?.version).toBe(1);
      expect(result.versions[1]?.isActive).toBe(false);
    }
  });

  it('returns template_not_found for an unknown template id', async () => {
    const { svc } = buildSvc();
    const result = await svc.listVersions('tpl_does_not_exist');
    expect(result.outcome).toBe('failed');
  });
});
