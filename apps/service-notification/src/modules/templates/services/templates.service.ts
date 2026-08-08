import { Injectable, Logger } from '@nestjs/common';

import type {
  NotificationChannelKind,
  NotificationLocale as ContractLocale,
  NotificationVariableEntry,
  RenderVariableValue,
} from '@taste-and-see/contracts';
import { NotificationVariableEntrySchema } from '@taste-and-see/contracts';

import { Prisma } from '../../../../prisma/generated';
import { PrismaService, type PrismaTransactionClient } from '../../../prisma/prisma.service';

import { HandlebarsRendererService, type RenderResult } from './handlebars-renderer.service';
import { MjmlCompilerService } from './mjml-compiler.service';
import {
  VariableValidatorService,
  type VariableValidationResult,
} from './variable-validator.service';

/**
 * Notification template orchestration (TS-072).
 *
 * Owns the lifecycle of a template:
 *
 *   1. **Create template** — `createTemplate()` inserts the registry
 *      row; `(code, locale)` UNIQUE so a re-submission returns a
 *      typed `code_locale_conflict` failure (the controller maps to
 *      409).
 *
 *   2. **Add version** — `createVersion()` inserts a new immutable
 *      content blob, monotonic per template. Email kinds compile MJML
 *      → HTML at write time so the render path stays sync. The
 *      version is optionally activated in the same transaction.
 *
 *   3. **Activate version** — `activateVersion()` flips
 *      `notification_templates.active_version_id`. Idempotent — a
 *      re-activation of the already-active version is a no-op.
 *
 *   4. **Read** — `getTemplateById()` / `listTemplates()` /
 *      `listVersions()` / `getVersion()` drive the admin UI.
 *
 *   5. **Render** — `render()` resolves `(code, locale)` → active
 *      version, validates the supplied variables against the version's
 *      declared schema, runs Handlebars on subject + html + text, and
 *      returns the assembled message ready for hand-off to a channel
 *      dispatcher (TS-073).
 *
 * **Per-kind body rules.** Enforced at three layers:
 *   - Contract layer (`CreateTemplateVersionRequestSchema` — TS-072
 *     contracts) — wire-shape validation.
 *   - Service layer (this file's `validateBodyShape()`) — readable
 *     error surface for the admin tooling.
 *   - DB layer (the `_body_shape_check` CHECK constraint in the
 *     init migration) — defence-in-depth against a regression.
 *
 * **Cross-service writes.** Service-notification doesn't mutate any
 * other service's tables. The `created_by_user_id` columns are soft
 * FKs to `identity.users.id`; the controller stamps them from the
 * RequestContext.
 */
@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mjml: MjmlCompilerService,
    private readonly handlebars: HandlebarsRendererService,
    private readonly variables: VariableValidatorService,
  ) {}

  // ─── Template CRUD ───────────────────────────────────────────────────

  async createTemplate(input: CreateTemplateInput): Promise<CreateTemplateResult> {
    try {
      const row = await this.prisma.notificationTemplate.create({
        data: {
          code: input.code,
          locale: toDbLocale(input.locale),
          kind: input.kind,
          name: input.name,
          description: input.description ?? null,
          createdByUserId: input.createdByUserId,
        },
      });
      return { outcome: 'ok', template: rowToTemplate(row) };
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        return {
          outcome: 'failed',
          failure: { kind: 'code_locale_conflict', code: input.code, locale: input.locale },
        };
      }
      throw err;
    }
  }

  async getTemplateById(id: string): Promise<GetTemplateResult> {
    const row = await this.prisma.notificationTemplate.findUnique({
      where: { id },
      include: {
        activeVersion: { select: { version: true } },
        versions: { orderBy: { version: 'desc' }, select: { version: true }, take: 1 },
      },
    });
    if (row === null) {
      return { outcome: 'failed', failure: { kind: 'template_not_found' } };
    }
    return { outcome: 'ok', template: rowToTemplateWithCounts(row) };
  }

  async listTemplates(query: ListTemplatesInput): Promise<ListTemplatesResult> {
    const limit = query.limit;
    const decoded = query.cursor !== undefined ? decodeCursor(query.cursor) : null;

    const rows = await this.prisma.notificationTemplate.findMany({
      where: {
        ...(query.kind !== undefined && { kind: query.kind }),
        ...(query.locale !== undefined && { locale: toDbLocale(query.locale) }),
        ...(query.code !== undefined && { code: query.code }),
        ...(decoded !== null && {
          OR: [
            { createdAt: { lt: decoded.createdAt } },
            { createdAt: { equals: decoded.createdAt }, id: { lt: decoded.id } },
          ],
        }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      include: {
        activeVersion: { select: { version: true } },
        versions: { orderBy: { version: 'desc' }, select: { version: true }, take: 1 },
      },
    });

    if (rows.length <= limit) {
      return {
        outcome: 'ok',
        templates: rows.map(rowToTemplateWithCounts),
        nextCursor: null,
      };
    }
    const slice = rows.slice(0, limit);
    const last = slice[slice.length - 1];
    if (last === undefined) {
      return { outcome: 'ok', templates: [], nextCursor: null };
    }
    return {
      outcome: 'ok',
      templates: slice.map(rowToTemplateWithCounts),
      nextCursor: encodeCursor(last.createdAt, last.id),
    };
  }

  // ─── Version CRUD ────────────────────────────────────────────────────

  async createVersion(input: CreateVersionInput): Promise<CreateVersionResult> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id: input.templateId },
    });
    if (template === null) {
      return { outcome: 'failed', failure: { kind: 'template_not_found' } };
    }

    // 1. Validate the body shape against the template kind. Mirrors
    //    the DB CHECK; the readable error message lives here.
    const shapeIssue = validateBodyShape(template.kind, input);
    if (shapeIssue !== null) {
      return { outcome: 'failed', failure: shapeIssue };
    }

    // 2. Re-validate the variables-schema array against the contract.
    //    The wire-shape validation already enforced this, but the
    //    service-layer re-check catches drift between the contract
    //    and the persisted shape.
    for (const entry of input.variablesSchema) {
      const parsed = NotificationVariableEntrySchema.safeParse(entry);
      if (!parsed.success) {
        return {
          outcome: 'failed',
          failure: { kind: 'invalid_variables_schema', message: parsed.error.message },
        };
      }
    }

    // 3. Compile MJML → HTML if the body is MJML. The compiled HTML
    //    lands in `body_html` for the render path; the MJML source
    //    is retained for round-trip editing.
    let derivedBodyHtml: string | null = input.bodyHtml ?? null;
    if (input.bodyMjml !== undefined && input.bodyMjml !== null) {
      const compiled = this.mjml.compile(input.bodyMjml);
      if (compiled.outcome === 'failed') {
        return {
          outcome: 'failed',
          failure: {
            kind: 'mjml_compilation_failed',
            errors: compiled.errors.map((e) => e.message),
          },
        };
      }
      derivedBodyHtml = compiled.html;
    }

    // 4. Per-template version monotonic. Wrapped in a $transaction so
    //    the MAX(version)+1 read + INSERT don't drift if a concurrent
    //    writer lands between the two operations — the UNIQUE
    //    (template_id, version) constraint catches the race and the
    //    service-layer recovery is to surface the conflict to the
    //    caller (retry-once is the admin tooling's responsibility,
    //    captured as TS-072-followup-2 candidate).
    try {
      const result = await this.prisma.$transaction(async (tx: PrismaTransactionClient) => {
        const head = await tx.notificationTemplateVersion.findFirst({
          where: { templateId: template.id },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const nextVersion = head === null ? 1 : head.version + 1;

        const inserted = await tx.notificationTemplateVersion.create({
          data: {
            templateId: template.id,
            kind: template.kind,
            version: nextVersion,
            subject: input.subject ?? null,
            bodyMjml: input.bodyMjml ?? null,
            bodyHtml: derivedBodyHtml,
            bodyText: input.bodyText ?? null,
            // `variables_schema` is a non-nullable `Json` column, so the
            // input alias is `Prisma.InputJsonValue` — the local
            // `PrismaJson` alias admitted `null`, which the real client
            // rejects here (TS-072-followup-6, closed by TS-501).
            variablesSchema: input.variablesSchema as unknown as Prisma.InputJsonValue,
            changeSummary: input.changeSummary ?? null,
            createdByUserId: input.createdByUserId,
          },
        });

        if (input.activate) {
          await tx.notificationTemplate.update({
            where: { id: template.id },
            data: { activeVersionId: inserted.id },
          });
        }

        return inserted;
      });

      return {
        outcome: 'ok',
        version: rowToVersion(result, input.activate),
      };
    } catch (err) {
      if (isPrismaUniqueViolation(err)) {
        return {
          outcome: 'failed',
          failure: { kind: 'version_conflict' },
        };
      }
      throw err;
    }
  }

  async activateVersion(input: ActivateVersionInput): Promise<ActivateVersionResult> {
    const version = await this.prisma.notificationTemplateVersion.findFirst({
      where: { templateId: input.templateId, version: input.version },
    });
    if (version === null) {
      return { outcome: 'failed', failure: { kind: 'version_not_found' } };
    }

    const updated = await this.prisma.notificationTemplate.update({
      where: { id: input.templateId },
      data: { activeVersionId: version.id },
    });

    this.logger.log(
      {
        templateId: input.templateId,
        templateCode: updated.code,
        version: input.version,
        activatedByUserId: input.actorUserId,
      },
      'notification.template.activated',
    );

    return {
      outcome: 'ok',
      version: rowToVersion(version, true),
    };
  }

  async listVersions(templateId: string): Promise<ListVersionsResult> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: { id: templateId },
      select: { activeVersionId: true },
    });
    if (template === null) {
      return { outcome: 'failed', failure: { kind: 'template_not_found' } };
    }

    const rows = await this.prisma.notificationTemplateVersion.findMany({
      where: { templateId },
      orderBy: { version: 'desc' },
    });

    return {
      outcome: 'ok',
      versions: rows.map((row: VersionRow) =>
        rowToVersion(row, row.id === template.activeVersionId),
      ),
    };
  }

  // ─── Render ──────────────────────────────────────────────────────────

  async render(input: RenderInput): Promise<RenderTemplateResult> {
    const template = await this.prisma.notificationTemplate.findUnique({
      where: {
        code_locale: { code: input.templateCode, locale: toDbLocale(input.locale) },
      },
      include: { activeVersion: true },
    });
    if (template === null || template.activeVersion === null) {
      return {
        outcome: 'failed',
        failure: { kind: 'template_or_active_version_not_found' },
      };
    }

    const activeVersion = template.activeVersion;
    const schema = parseVariablesSchema(activeVersion.variablesSchema);

    const validated: VariableValidationResult = this.variables.validate({
      schema,
      variables: input.variables,
    });
    if (validated.outcome === 'failed') {
      return {
        outcome: 'failed',
        failure: {
          kind: 'variable_validation_failed',
          issues: validated.issues.map((issue) => ({
            kind: issue.kind,
            variableName: issue.variableName,
            message: issue.message,
          })),
        },
      };
    }

    const subjectResult =
      activeVersion.subject !== null
        ? this.handlebars.render({
            source: activeVersion.subject,
            variables: validated.variables,
            escapeMode: 'text',
          })
        : null;
    const htmlResult =
      activeVersion.bodyHtml !== null
        ? this.handlebars.render({
            source: activeVersion.bodyHtml,
            variables: validated.variables,
            escapeMode: 'html',
          })
        : null;
    const textResult =
      activeVersion.bodyText !== null
        ? this.handlebars.render({
            source: activeVersion.bodyText,
            variables: validated.variables,
            escapeMode: 'text',
          })
        : null;

    const failed = [subjectResult, htmlResult, textResult].find(
      (result): result is Extract<RenderResult, { outcome: 'failed' }> =>
        result !== null && result.outcome === 'failed',
    );
    if (failed !== undefined) {
      return {
        outcome: 'failed',
        failure: {
          kind: 'handlebars_render_failed',
          message: failed.message,
        },
      };
    }

    return {
      outcome: 'ok',
      rendered: {
        templateCode: template.code,
        locale: fromDbLocale(template.locale),
        kind: template.kind,
        version: activeVersion.version,
        subject: subjectResult?.outcome === 'ok' ? subjectResult.output : null,
        bodyHtml: htmlResult?.outcome === 'ok' ? htmlResult.output : null,
        bodyText: textResult?.outcome === 'ok' ? textResult.output : null,
      },
    };
  }
}

// ─── Per-kind body-shape validation ─────────────────────────────────────

/**
 * Mirror of the DB CHECK constraint
 * `notification_template_versions_body_shape_check`. Service-layer
 * version exists so a misshaped request surfaces with a readable
 * failure shape rather than a generic Postgres `23514` error.
 */
function validateBodyShape(
  kind: NotificationChannelKind,
  input: CreateVersionInput,
): TemplatesServiceFailure | null {
  switch (kind) {
    case 'email': {
      if (input.subject === undefined || input.subject === null) {
        return { kind: 'invalid_body_shape', message: 'email templates require `subject`' };
      }
      const hasMjml = input.bodyMjml !== undefined && input.bodyMjml !== null;
      const hasHtml = input.bodyHtml !== undefined && input.bodyHtml !== null;
      if (!hasMjml && !hasHtml) {
        return {
          kind: 'invalid_body_shape',
          message: 'email templates require either `bodyMjml` or `bodyHtml`',
        };
      }
      return null;
    }
    case 'sms': {
      if (input.bodyText === undefined || input.bodyText === null) {
        return { kind: 'invalid_body_shape', message: 'sms templates require `bodyText`' };
      }
      if (input.subject !== undefined && input.subject !== null) {
        return {
          kind: 'invalid_body_shape',
          message: 'sms templates must not carry a `subject`',
        };
      }
      if (input.bodyMjml !== undefined && input.bodyMjml !== null) {
        return {
          kind: 'invalid_body_shape',
          message: 'sms templates must not carry MJML',
        };
      }
      if (input.bodyHtml !== undefined && input.bodyHtml !== null) {
        return {
          kind: 'invalid_body_shape',
          message: 'sms templates must not carry HTML',
        };
      }
      return null;
    }
    case 'push':
    case 'in_app': {
      if (input.bodyText === undefined || input.bodyText === null) {
        return { kind: 'invalid_body_shape', message: `${kind} templates require \`bodyText\`` };
      }
      if (input.bodyMjml !== undefined && input.bodyMjml !== null) {
        return {
          kind: 'invalid_body_shape',
          message: `${kind} templates must not carry MJML`,
        };
      }
      if (input.bodyHtml !== undefined && input.bodyHtml !== null) {
        return {
          kind: 'invalid_body_shape',
          message: `${kind} templates must not carry HTML`,
        };
      }
      return null;
    }
  }
}

// ─── Locale translation ─────────────────────────────────────────────────

/**
 * The contract uses BCP-47-style `en-US` / `es-US` / `zh-CN`; the
 * Postgres enum uses snake_case `en_US` / `es_US` / `zh_CN` because the
 * BCP-47 hyphen isn't a legal enum-literal character. Translation
 * happens at the service boundary so neither side leaks into the
 * other.
 */
type DbLocale = 'en_US' | 'es_US' | 'zh_CN';

function toDbLocale(value: ContractLocale): DbLocale {
  switch (value) {
    case 'en-US':
      return 'en_US';
    case 'es-US':
      return 'es_US';
    case 'zh-CN':
      return 'zh_CN';
  }
}

function fromDbLocale(value: DbLocale): ContractLocale {
  switch (value) {
    case 'en_US':
      return 'en-US';
    case 'es_US':
      return 'es-US';
    case 'zh_CN':
      return 'zh-CN';
  }
}

// ─── Variables-schema parsing ───────────────────────────────────────────

/**
 * The JSONB column stores the variables-schema array verbatim from the
 * contract-validated payload. We re-parse on the read path so a future
 * contract tightening surfaces as a render-time failure rather than a
 * runtime crash inside Handlebars.
 */
function parseVariablesSchema(value: unknown): NotificationVariableEntry[] {
  if (!Array.isArray(value)) return [];
  const out: NotificationVariableEntry[] = [];
  for (const entry of value) {
    const parsed = NotificationVariableEntrySchema.safeParse(entry);
    if (parsed.success) {
      out.push(parsed.data);
    }
  }
  return out;
}

// ─── Cursor encode/decode ───────────────────────────────────────────────

interface DecodedCursor {
  readonly createdAt: Date;
  readonly id: string;
}

function encodeCursor(createdAt: Date, id: string): string {
  const payload = JSON.stringify({
    createdAt: createdAt.toISOString(),
    id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): DecodedCursor | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof (parsed as Record<string, unknown>)['createdAt'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['id'] !== 'string'
    ) {
      return null;
    }
    const createdAtRaw = (parsed as Record<string, unknown>)['createdAt'] as string;
    const idRaw = (parsed as Record<string, unknown>)['id'] as string;
    const createdAt = new Date(createdAtRaw);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: idRaw };
  } catch {
    return null;
  }
}

// ─── Row → domain projections ───────────────────────────────────────────

type TemplateRow = {
  readonly id: string;
  readonly code: string;
  readonly locale: DbLocale;
  readonly kind: NotificationChannelKind;
  readonly name: string;
  readonly description: string | null;
  readonly activeVersionId: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

type TemplateRowWithCounts = TemplateRow & {
  readonly activeVersion: { readonly version: number } | null;
  readonly versions: ReadonlyArray<{ readonly version: number }>;
};

function rowToTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    code: row.code,
    locale: fromDbLocale(row.locale),
    kind: row.kind,
    name: row.name,
    description: row.description,
    activeVersionId: row.activeVersionId,
    activeVersionNumber: null,
    latestVersionNumber: null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToTemplateWithCounts(row: TemplateRowWithCounts): Template {
  const latest = row.versions[0];
  return {
    id: row.id,
    code: row.code,
    locale: fromDbLocale(row.locale),
    kind: row.kind,
    name: row.name,
    description: row.description,
    activeVersionId: row.activeVersionId,
    activeVersionNumber: row.activeVersion?.version ?? null,
    latestVersionNumber: latest !== undefined ? latest.version : null,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

type VersionRow = {
  readonly id: string;
  readonly templateId: string;
  readonly kind: NotificationChannelKind;
  readonly version: number;
  readonly subject: string | null;
  readonly bodyMjml: string | null;
  readonly bodyHtml: string | null;
  readonly bodyText: string | null;
  readonly variablesSchema: unknown;
  readonly changeSummary: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
};

function rowToVersion(row: VersionRow, isActive: boolean): TemplateVersion {
  return {
    id: row.id,
    templateId: row.templateId,
    kind: row.kind,
    version: row.version,
    subject: row.subject,
    bodyMjml: row.bodyMjml,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    variablesSchema: parseVariablesSchema(row.variablesSchema),
    isActive,
    changeSummary: row.changeSummary,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}

// ─── Domain types ───────────────────────────────────────────────────────

export interface Template {
  readonly id: string;
  readonly code: string;
  readonly locale: ContractLocale;
  readonly kind: NotificationChannelKind;
  readonly name: string;
  readonly description: string | null;
  readonly activeVersionId: string | null;
  readonly activeVersionNumber: number | null;
  readonly latestVersionNumber: number | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TemplateVersion {
  readonly id: string;
  readonly templateId: string;
  readonly kind: NotificationChannelKind;
  readonly version: number;
  readonly subject: string | null;
  readonly bodyMjml: string | null;
  readonly bodyHtml: string | null;
  readonly bodyText: string | null;
  readonly variablesSchema: readonly NotificationVariableEntry[];
  readonly isActive: boolean;
  readonly changeSummary: string | null;
  readonly createdByUserId: string;
  readonly createdAt: Date;
}

export interface RenderedTemplate {
  readonly templateCode: string;
  readonly locale: ContractLocale;
  readonly kind: NotificationChannelKind;
  readonly version: number;
  readonly subject: string | null;
  readonly bodyHtml: string | null;
  readonly bodyText: string | null;
}

// ─── I/O shapes ─────────────────────────────────────────────────────────

export interface CreateTemplateInput {
  readonly code: string;
  readonly locale: ContractLocale;
  readonly kind: NotificationChannelKind;
  readonly name: string;
  readonly description?: string | undefined;
  readonly createdByUserId: string;
}

export interface CreateVersionInput {
  readonly templateId: string;
  readonly subject?: string | undefined;
  readonly bodyMjml?: string | undefined;
  readonly bodyHtml?: string | undefined;
  readonly bodyText?: string | undefined;
  readonly variablesSchema: readonly NotificationVariableEntry[];
  readonly activate: boolean;
  readonly changeSummary?: string | undefined;
  readonly createdByUserId: string;
}

export interface ActivateVersionInput {
  readonly templateId: string;
  readonly version: number;
  readonly actorUserId: string;
}

export interface ListTemplatesInput {
  readonly kind?: NotificationChannelKind | undefined;
  readonly locale?: ContractLocale | undefined;
  readonly code?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}

export interface RenderInput {
  readonly templateCode: string;
  readonly locale: ContractLocale;
  readonly variables: Readonly<Record<string, RenderVariableValue>> | undefined;
}

// ─── Result shapes ──────────────────────────────────────────────────────

export type CreateTemplateResult =
  | { readonly outcome: 'ok'; readonly template: Template }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type GetTemplateResult =
  | { readonly outcome: 'ok'; readonly template: Template }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type ListTemplatesResult =
  | {
      readonly outcome: 'ok';
      readonly templates: readonly Template[];
      readonly nextCursor: string | null;
    }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type CreateVersionResult =
  | { readonly outcome: 'ok'; readonly version: TemplateVersion }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type ActivateVersionResult =
  | { readonly outcome: 'ok'; readonly version: TemplateVersion }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type ListVersionsResult =
  | { readonly outcome: 'ok'; readonly versions: readonly TemplateVersion[] }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type RenderTemplateResult =
  | { readonly outcome: 'ok'; readonly rendered: RenderedTemplate }
  | { readonly outcome: 'failed'; readonly failure: TemplatesServiceFailure };

export type TemplatesServiceFailure =
  | {
      readonly kind: 'code_locale_conflict';
      readonly code: string;
      readonly locale: ContractLocale;
    }
  | { readonly kind: 'template_not_found' }
  | { readonly kind: 'version_not_found' }
  | { readonly kind: 'version_conflict' }
  | { readonly kind: 'invalid_body_shape'; readonly message: string }
  | { readonly kind: 'invalid_variables_schema'; readonly message: string }
  | {
      readonly kind: 'mjml_compilation_failed';
      readonly errors: readonly string[];
    }
  | {
      readonly kind: 'template_or_active_version_not_found';
    }
  | {
      readonly kind: 'variable_validation_failed';
      readonly issues: ReadonlyArray<{
        readonly kind: 'missing_required' | 'unknown_variable' | 'type_mismatch';
        readonly variableName: string;
        readonly message: string;
      }>;
    }
  | { readonly kind: 'handlebars_render_failed'; readonly message: string };

// ─── Prisma helpers ─────────────────────────────────────────────────────

/**
 * Duck-typed narrowing for Prisma's P2002 unique-constraint failure.
 * Tracks the established TS-021-followup-2 root cause — Prisma 5.22's
 * namespace value-side resolves inconsistently under our
 * `verbatimModuleSyntax: false` / `isolatedModules: true` tsconfig.
 * The cleanup is captured as TS-072-followup-6.
 */
function isPrismaUniqueViolation(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'P2002'
  );
}
