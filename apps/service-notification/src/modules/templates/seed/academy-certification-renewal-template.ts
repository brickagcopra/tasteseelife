import {
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
  ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES,
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
 * Seed for the certification-renewal reminder email template (TS-256;
 * PRD §9.3; PDD §12.2, §15.2).
 *
 * The certification-renewal worker dispatches `templateCode =
 * 'academy-certification-renewal'` at the 90 / 60 / 30 / 7-day milestones;
 * the render path 404s if no active version exists, so this template MUST
 * be seeded before the worker can send anything. Mirrors the TS-235
 * wellness-summary seed shape one-for-one (a pure idempotent builder + an
 * idempotent seeder wired into the pre-rollout Kubernetes Job).
 *
 * **Single source of truth for variables.** The declared variable schema
 * comes from `ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES` in
 * `@taste-and-see/contracts`, the SAME constant the worker reads to build
 * its dispatch payload — so the seed and the worker cannot drift.
 *
 * **Idempotent.** Re-running is safe (same no-op-when-already-active /
 * activate-existing semantics as the wellness-summary seed).
 */

const DB_LOCALE = DB_LOCALE_EN_US; // contract 'en-US' → Postgres enum value
const DB_KIND = ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CHANNEL; // 'email'

/** Subject line (Handlebars). */
const SUBJECT = 'Your {{courseTitle}} certification renews in {{daysUntilExpiry}} days';

/**
 * MJML body (Handlebars). Warm, professional, non-clinical copy
 * (CLAUDE.md §12). Surfaces the course + track + the human expiry date and
 * a clear renew CTA. Provider-facing (the certification holder), so the
 * tone is collegial rather than family-soft.
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
          Hello {{holderName}},
        </mj-text>
        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.6">
          Your <strong>{{courseTitle}}</strong> certification ({{trackLabel}}) is coming up for renewal.
          It expires on <strong>{{expiresOn}}</strong> — about {{daysUntilExpiry}} day(s) from now.
        </mj-text>
        <mj-text font-size="15px" font-family="Helvetica, Arial, sans-serif" color="#5b504a" line-height="1.6">
          Keeping your certification current preserves your tier eligibility and your place in the
          Taste &amp; See community. You can renew or complete your continuing education any time.
        </mj-text>
        <mj-button background-color="#a8553a" color="#ffffff" border-radius="8px" font-size="15px" href="{{renewUrl}}" padding="16px 0">
          Renew your certification
        </mj-button>
        <mj-divider border-color="#e7ded3" border-width="1px" padding="12px 0" />
        <mj-text font-size="13px" font-family="Helvetica, Arial, sans-serif" color="#8a7d73" line-height="1.6">
          With gratitude for your work,<br/>
          The {{appName}} Cooking Academy team
        </mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

/**
 * Plain-text fallback (Handlebars). Mirrors the MJML content for clients
 * that don't render HTML.
 */
const BODY_TEXT = `Hello {{holderName}},

Your {{courseTitle}} certification ({{trackLabel}}) is coming up for renewal. It expires on {{expiresOn}} — about {{daysUntilExpiry}} day(s) from now.

Keeping your certification current preserves your tier eligibility and your place in the Taste & See community. You can renew or complete your continuing education any time:

{{renewUrl}}

With gratitude for your work,
The {{appName}} Cooking Academy team`;

/**
 * The template definition, independent of any DB connection — exported so
 * the unit test can assert its shape (variables match the shared contract,
 * the MJML compiles, the subject/bodies are present).
 */
export type AcademyCertificationRenewalTemplateSeed = NotificationTemplateSeedDefinition;

export function buildAcademyCertificationRenewalTemplateSeed(): AcademyCertificationRenewalTemplateSeed {
  return {
    code: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_CODE,
    dbLocale: DB_LOCALE,
    kind: DB_KIND,
    name: 'Academy certification renewal reminder',
    description:
      'Sent to a certification holder at the 90 / 60 / 30 / 7-day milestones before their Cooking Academy certification expires, with the course + track + expiry date and a renew CTA (TS-256).',
    subject: SUBJECT,
    bodyMjml: BODY_MJML,
    bodyText: BODY_TEXT,
    variablesSchema: ACADEMY_CERTIFICATION_RENEWAL_TEMPLATE_VARIABLES,
    changeSummary: 'TS-256 initial certification-renewal template seed.',
  };
}

export type AcademyCertificationRenewalSeedReport = NotificationTemplateSeedReport;

/**
 * Idempotently seed the certification-renewal template + its active
 * version. Delegates to the shared `seedNotificationTemplate` mechanism
 * (TS-042-followup-3a3); this file owns only the definition.
 */
export async function seedAcademyCertificationRenewalTemplate(
  prisma: PrismaService,
  mjml: MjmlCompilerService,
): Promise<AcademyCertificationRenewalSeedReport> {
  return seedNotificationTemplate(
    prisma,
    mjml,
    buildAcademyCertificationRenewalTemplateSeed(),
    'seed-academy-certification-renewal-template',
  );
}
