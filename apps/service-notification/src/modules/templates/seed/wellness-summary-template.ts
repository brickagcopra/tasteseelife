import {
  WELLNESS_SUMMARY_TEMPLATE_CHANNEL,
  WELLNESS_SUMMARY_TEMPLATE_CODE,
  WELLNESS_SUMMARY_TEMPLATE_VARIABLES,
} from '@taste-and-see/contracts';

import type { PrismaService } from '../../../prisma/prisma.service';
import { MjmlCompilerService } from '../services/mjml-compiler.service';

import {
  DB_LOCALE_EN_US,
  seedNotificationTemplate,
  type NotificationTemplateSeedDefinition,
  type NotificationTemplateSeedReport,
} from './notification-template-seed';

/**
 * Seed for the monthly wellness-summary email template (TS-235; PDD §12.2).
 *
 * The wellness-summary worker dispatches `templateCode =
 * 'wellness-summary-monthly'`; the render path 404s if no active version
 * exists, so this template MUST be seeded before the worker can send
 * anything. Mirrors the plan-catalog / chart-of-accounts / RBAC seed
 * pattern (a pure idempotent function + a CLI entry-point wired into a
 * pre-rollout Kubernetes Job — TS-235-followup).
 *
 * **Single source of truth for variables.** The declared variable schema
 * comes from `WELLNESS_SUMMARY_TEMPLATE_VARIABLES` in
 * `@taste-and-see/contracts`, the SAME constant the worker reads to build
 * its dispatch payload. The render-time variable validation rejects a
 * dispatch that omits a required variable or sends an unknown one, so the
 * seed and the worker MUST agree — sharing one contract constant is what
 * guarantees they do.
 *
 * **Idempotent.** Re-running is safe — the shared
 * `seedNotificationTemplate` mechanism (TS-042-followup-3a3) owns the
 * find-or-create / append-version / activate semantics; this file owns only
 * the definition.
 */

const DB_LOCALE = DB_LOCALE_EN_US; // contract 'en-US' → Postgres enum value
const DB_KIND = WELLNESS_SUMMARY_TEMPLATE_CHANNEL; // 'email' — same token in both layers

/** Subject line (Handlebars). */
const SUBJECT = "{{seniorName}}'s wellness summary — {{periodLabel}}";

/**
 * MJML body (Handlebars). Warm, hospitality-forward, non-clinical copy
 * (CLAUDE.md §12). The observation-detail block renders only when
 * `detailShared` is true — a family observer the senior hasn't shared
 * `notes` with sees the visit count + a gentle note, never the scale
 * detail. The four scale summaries are still supplied (empty when
 * withheld) so render-time variable validation passes.
 */
const BODY_MJML = `<mjml>
  <mj-body background-color="#f7f3ed">
    <mj-section padding="24px 0 8px">
      <mj-column>
        <mj-text font-size="22px" font-family="Georgia, 'Times New Roman', serif" color="#3b2f2a" align="center">
          {{appName}}
        </mj-text>
      </mj-column>
    </mj-section>
    <mj-section background-color="#ffffff" border-radius="12px" padding="24px">
      <mj-column>
        <mj-text font-size="18px" font-family="Helvetica, Arial, sans-serif" color="#3b2f2a">
          Hello,
        </mj-text>
        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.6">
          Here is a gentle look back at {{seniorName}}'s companion visits over {{periodLabel}}.
          During this time there {{#if totalVisits}}were{{else}}were{{/if}} {{totalVisits}} completed visit(s).
        </mj-text>
        {{#if detailShared}}
        <mj-divider border-color="#e7ded3" border-width="1px" padding="12px 0" />
        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.7">
          {{moodSummary}}<br/>
          {{appetiteSummary}}<br/>
          {{hydrationSummary}}<br/>
          {{socialSummary}}
        </mj-text>
        {{else}}
        <mj-text font-size="14px" font-family="Helvetica, Arial, sans-serif" color="#8a7d73" line-height="1.6">
          {{seniorName}} hasn't chosen to share visit observations with you yet. You'll still see when visits happen.
        </mj-text>
        {{/if}}
        <mj-divider border-color="#e7ded3" border-width="1px" padding="12px 0" />
        <mj-text font-size="13px" font-family="Helvetica, Arial, sans-serif" color="#8a7d73" line-height="1.6">
          With warmth,<br/>
          The {{appName}} team
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/**
 * Plain-text fallback (Handlebars). Email clients that don't render HTML
 * fall back to this; it mirrors the MJML content.
 */
const BODY_TEXT = `Hello,

Here is a gentle look back at {{seniorName}}'s companion visits over {{periodLabel}}. During this time there were {{totalVisits}} completed visit(s).
{{#if detailShared}}
{{moodSummary}}
{{appetiteSummary}}
{{hydrationSummary}}
{{socialSummary}}
{{else}}
{{seniorName}} hasn't chosen to share visit observations with you yet. You'll still see when visits happen.
{{/if}}
With warmth,
The {{appName}} team`;

/**
 * The template definition, independent of any DB connection — exported so
 * the unit test can assert its shape (variables match the shared contract,
 * the MJML compiles, the subject/bodies are present).
 */
export type WellnessSummaryTemplateSeed = NotificationTemplateSeedDefinition;

export function buildWellnessSummaryTemplateSeed(): WellnessSummaryTemplateSeed {
  return {
    code: WELLNESS_SUMMARY_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Monthly wellness summary',
    description:
      'Sent to a household’s family members + senior with the prior period’s companion-visit count and (consent-permitting) wellness observation roll-up (TS-235).',
    subject: SUBJECT,
    bodyMjml: BODY_MJML,
    bodyText: BODY_TEXT,
    variablesSchema: WELLNESS_SUMMARY_TEMPLATE_VARIABLES,
    changeSummary: 'TS-235 initial wellness-summary template seed.',
  };
}

export type WellnessSummarySeedReport = NotificationTemplateSeedReport;

/**
 * Idempotently seed the wellness-summary template + its active version.
 */
export async function seedWellnessSummaryTemplate(
  prisma: PrismaService,
  mjml: MjmlCompilerService,
): Promise<WellnessSummarySeedReport> {
  return seedNotificationTemplate(
    prisma,
    mjml,
    buildWellnessSummaryTemplateSeed(),
    'seed-wellness-summary-template',
  );
}
