import { Logger } from '@nestjs/common';
import type { NotificationChannelKind, NotificationVariableEntry } from '@taste-and-see/contracts';

import type { PrismaService, PrismaTransactionClient } from '../../../prisma/prisma.service';
import { MjmlCompilerService } from '../services/mjml-compiler.service';

/**
 * The idempotent seed mechanism shared by every system notification
 * template (TS-042-followup-3a3).
 *
 * TS-235 (wellness summary) and TS-256 (certification renewal) each carried
 * their own byte-identical copy of this ~70-line upsert; the four dunning
 * templates would have made six. The mechanism — compile, find-or-create
 * the template row, append the next version, activate it — is the same for
 * every template and has nothing template-specific in it. What differs is
 * only the DEFINITION: code, name, subject, bodies, variables.
 *
 * The two original seeds now delegate here and keep their own exported
 * `seedXTemplate` entry points, so the CLI script and their existing tests
 * are unchanged.
 *
 * **Idempotent.** Re-running is safe: a template that already has an active
 * version is a no-op (it does NOT pile up a fresh version on every deploy).
 * A template row that exists WITHOUT an active version (a half-applied
 * prior run) gets the next version created and activated.
 */

/** Postgres enum value for the Phase-1 locale (contract `en-US`). */
export const DB_LOCALE_EN_US = 'en_US' as const;

/** Author recorded on seeded rows — these are system templates, not an operator's. */
export const SEED_AUTHOR_USER_ID = 'system';

/**
 * A template definition, independent of any DB connection — exported so
 * unit tests can assert its shape (variables match the shared contract, the
 * MJML compiles, every declared variable is actually referenced) without
 * touching Prisma.
 */
export interface NotificationTemplateSeedDefinition {
  readonly code: string;
  readonly dbLocale: typeof DB_LOCALE_EN_US;
  /** Channel kind — `email` for every template seeded so far. */
  readonly kind: NotificationChannelKind;
  readonly name: string;
  readonly description: string;
  readonly subject: string;
  readonly bodyMjml: string;
  readonly bodyText: string;
  readonly variablesSchema: readonly NotificationVariableEntry[];
  /** Recorded on the version row; names the task that introduced it. */
  readonly changeSummary: string;
}

export interface NotificationTemplateSeedReport {
  readonly outcome: 'created' | 'already_active' | 'activated_existing';
  readonly templateCode: string;
  readonly version: number | null;
}

/**
 * Idempotently seed one template + its active version.
 *
 * Pure over the injected `prisma` + `mjml` collaborators so it is
 * unit-testable and reusable from the CLI script.
 *
 * @param loggerContext - Nest logger context, so a multi-template seed run
 *   still reports which template each line is about.
 */
export async function seedNotificationTemplate(
  prisma: PrismaService,
  mjml: MjmlCompilerService,
  seed: NotificationTemplateSeedDefinition,
  loggerContext = 'seed-notification-template',
): Promise<NotificationTemplateSeedReport> {
  const logger = new Logger(loggerContext);

  const existing = await prisma.notificationTemplate.findUnique({
    where: { code_locale: { code: seed.code, locale: seed.dbLocale } },
    select: { id: true, activeVersionId: true },
  });

  if (existing?.activeVersionId != null) {
    logger.log(
      { templateCode: seed.code, locale: seed.dbLocale },
      'template already has an active version — no-op',
    );
    return { outcome: 'already_active', templateCode: seed.code, version: null };
  }

  // Compile MJML → HTML at seed time (the render path serves the compiled
  // HTML; the MJML source is retained for round-trip editing). A failure
  // here is a deploy-blocking bug in the template source, so we throw —
  // seeding a template whose body did not compile would leave the render
  // path serving an empty email.
  const compiled = mjml.compile(seed.bodyMjml);
  if (compiled.outcome === 'failed') {
    throw new Error(
      `${seed.code} template MJML failed to compile: ${compiled.errors
        .map((e) => e.message)
        .join('; ')}`,
    );
  }
  const bodyHtml = compiled.html;

  const version = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
    const template =
      existing ??
      (await tx.notificationTemplate.create({
        data: {
          code: seed.code,
          locale: seed.dbLocale,
          kind: seed.kind,
          name: seed.name,
          description: seed.description,
          createdByUserId: SEED_AUTHOR_USER_ID,
        },
        select: { id: true, activeVersionId: true },
      }));

    const head = await tx.notificationTemplateVersion.findFirst({
      where: { templateId: template.id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = head === null ? 1 : head.version + 1;

    const inserted = await tx.notificationTemplateVersion.create({
      data: {
        templateId: template.id,
        kind: seed.kind,
        version: nextVersion,
        subject: seed.subject,
        bodyMjml: seed.bodyMjml,
        bodyHtml,
        bodyText: seed.bodyText,
        // The contract array is the source of truth; persisted verbatim
        // and re-validated on the render path.
        variablesSchema: seed.variablesSchema as unknown as object,
        changeSummary: seed.changeSummary,
        createdByUserId: SEED_AUTHOR_USER_ID,
      },
      select: { id: true, version: true },
    });

    await tx.notificationTemplate.update({
      where: { id: template.id },
      data: { activeVersionId: inserted.id },
    });

    return inserted.version;
  });

  const outcome = existing === null ? 'created' : 'activated_existing';
  logger.log(
    { templateCode: seed.code, locale: seed.dbLocale, version, outcome },
    'template seeded',
  );
  return { outcome, templateCode: seed.code, version };
}
