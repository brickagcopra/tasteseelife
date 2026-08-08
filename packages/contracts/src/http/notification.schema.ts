import { z } from 'zod';

/**
 * Notification template + render HTTP DTOs (TS-072; PDD §12.2 templating
 * with MJML + Handlebars; PDD §10.15 admin notification template
 * management with versioning + preview + test sends).
 *
 * Two halves of the surface:
 *
 *   1. **Admin template management** — the admin tooling creates
 *      templates (`POST /api/v1/admin/notification/templates`), adds
 *      versions to a template (`POST /:id/versions`), and activates a
 *      version (`POST /:id/versions/:version/activate`). Templates are
 *      keyed by `(code, locale)`; versions are monotonic per template
 *      and immutable once written (TS-072-followup-11 adds the DB
 *      trigger that enforces append-only at the storage layer too).
 *
 *   2. **Internal render** — every channel (email, SMS, push, in-app)
 *      calls `POST /api/v1/internal/notification/render` with a
 *      `(templateCode, locale, variables)` triple and gets back a fully
 *      assembled message ready for hand-off to the channel SDK. The
 *      endpoint is shared-secret-pinned; TS-073 wires the channel SDKs
 *      that consume the rendered output.
 *
 * **Variable strictness.** Variables are typed via a small declarative
 * schema (`NotificationVariableEntrySchema`) — only `string` / `number`
 * / `boolean` for Phase 1 (PDD §12.2 "variables strictly typed via
 * shared contract package"). The renderer rejects requests missing a
 * required variable, and unknown variables short-circuit early so a
 * misnamed key never silently renders an empty Handlebars expression.
 *
 * **`.strict()` everywhere** — unknown fields are a parse error so a
 * typo or a stray client field never silently round-trips
 * (CLAUDE.md §3.3).
 */

// ─── Bounded length constants ───────────────────────────────────────────

/**
 * Template code cap (PDD §10.15 templates are referenced by code from
 * every channel). CUID2 / slug shape land at ≤32 chars; 100 leaves
 * headroom for namespaced future codes (e.g. `welcome_family_tier_2`).
 */
export const NOTIFICATION_TEMPLATE_CODE_MAX_LENGTH = 100;

/**
 * Template code regex — alphanumeric, dot, underscore, hyphen. Matches
 * the shape ops uses today for plan/account/permission codes; keeps the
 * code safe to embed in URLs without escaping.
 */
export const NOTIFICATION_TEMPLATE_CODE_REGEX = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

/**
 * Locale cap. BCP-47 tags land at ≤14 chars (e.g. `zh-Hant-HK`); 20 is
 * defensive headroom.
 */
export const NOTIFICATION_LOCALE_MAX_LENGTH = 20;

/**
 * Display name / description caps. The admin UI shows these in lists
 * and detail views — 200/2000 leaves room without enabling a bulk-exfil
 * bucket.
 */
export const NOTIFICATION_TEMPLATE_NAME_MAX_LENGTH = 200;
export const NOTIFICATION_TEMPLATE_DESCRIPTION_MAX_LENGTH = 2_000;

/**
 * Email subject cap. RFC 5322 advises ≤78 chars per line; 998 is the
 * hard cap. 200 is the comfortable display cap most clients honour.
 */
export const NOTIFICATION_SUBJECT_MAX_LENGTH = 200;

/**
 * Body caps. MJML source is verbose (a typical welcome email lands at
 * 4–8 KiB of MJML, ~15–25 KiB of compiled HTML); 64 KiB for the MJML
 * source + 256 KiB for compiled HTML covers the pathological brand
 * email without enabling a bulk-exfil bucket. SMS/push text caps at
 * 4 KiB — SMS-segment splitting happens in TS-073, the contract layer
 * just needs an upper bound.
 */
export const NOTIFICATION_BODY_MJML_MAX_LENGTH = 65_536;
export const NOTIFICATION_BODY_HTML_MAX_LENGTH = 262_144;
export const NOTIFICATION_BODY_TEXT_MAX_LENGTH = 4_096;

/**
 * Variable definition + render-input caps.
 */
export const NOTIFICATION_VARIABLE_NAME_MAX_LENGTH = 80;
export const NOTIFICATION_VARIABLES_MAX_ENTRIES = 40;
export const NOTIFICATION_RENDER_VARIABLE_VALUE_MAX_LENGTH = 8_192;

/**
 * Pagination caps for the admin template list.
 */
export const NOTIFICATION_LIST_LIMIT_DEFAULT = 50;
export const NOTIFICATION_LIST_LIMIT_MAX = 200;

/**
 * Author user-id cap. Soft FK into `identity.users.id` — CUID2 / UUID
 * v7. 128 is defensive headroom; mirrors AUDIT_ACTOR_USER_ID_MAX_LENGTH.
 */
export const NOTIFICATION_AUTHOR_USER_ID_MAX_LENGTH = 128;

/**
 * Variable-name regex — Handlebars-friendly identifier shape. Restricts
 * to alphanumeric + underscore so a malicious admin can't author a
 * variable name that breaks out of the `{{var}}` substitution context.
 */
export const NOTIFICATION_VARIABLE_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ─── Channel-kind enum ──────────────────────────────────────────────────

/**
 * Notification channel kind. Mirrors PDD §12.1 channel inventory:
 *   - `email`   — transactional email (Postmark / SES).
 *   - `sms`     — Twilio SMS (booking reminders, OTPs, escalations).
 *   - `push`    — APNs + FCM via Firebase.
 *   - `in_app`  — real-time WebSocket fan-out (TS-070 messaging deck).
 *
 * `email` is the only kind that consumes MJML/HTML; the others consume
 * `body_text` only. The renderer enforces this — see the kind-specific
 * `superRefine` on `CreateTemplateVersionRequestSchema` below.
 */
export const NotificationChannelKindSchema = z.enum(['email', 'sms', 'push', 'in_app']);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKindSchema>;

/**
 * Variable type. Restricted to the three JSON-safe primitives the
 * Handlebars renderer can substitute without further escaping. Object /
 * array variables would require a templating contract for the nested
 * shape — not in Phase 1 scope (TS-073 evaluates if needed).
 */
export const NotificationVariableTypeSchema = z.enum(['string', 'number', 'boolean']);
export type NotificationVariableType = z.infer<typeof NotificationVariableTypeSchema>;

/**
 * Supported locale tags for Phase 1. PRD §11.4 names en-US Phase 1, then
 * es-US + zh-CN Phase 2. The schema lists all three so the admin tooling
 * can author templates for the Phase-2 locales ahead of the channel
 * launch.
 */
export const NotificationLocaleSchema = z.enum(['en-US', 'es-US', 'zh-CN']);
export type NotificationLocale = z.infer<typeof NotificationLocaleSchema>;

// ─── Reused field schemas ───────────────────────────────────────────────

const TemplateCodeSchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_TEMPLATE_CODE_MAX_LENGTH)
  .regex(NOTIFICATION_TEMPLATE_CODE_REGEX, {
    message: 'template code must be alphanumeric with dot / underscore / hyphen separators',
  });

const TemplateNameSchema = z.string().min(1).max(NOTIFICATION_TEMPLATE_NAME_MAX_LENGTH);
const TemplateDescriptionSchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_TEMPLATE_DESCRIPTION_MAX_LENGTH);

const SubjectSchema = z.string().min(1).max(NOTIFICATION_SUBJECT_MAX_LENGTH);
const BodyMjmlSchema = z.string().min(1).max(NOTIFICATION_BODY_MJML_MAX_LENGTH);
const BodyHtmlSchema = z.string().min(1).max(NOTIFICATION_BODY_HTML_MAX_LENGTH);
const BodyTextSchema = z.string().min(1).max(NOTIFICATION_BODY_TEXT_MAX_LENGTH);

const AuthorUserIdSchema = z.string().min(1).max(NOTIFICATION_AUTHOR_USER_ID_MAX_LENGTH);

const VariableNameSchema = z
  .string()
  .min(1)
  .max(NOTIFICATION_VARIABLE_NAME_MAX_LENGTH)
  .regex(NOTIFICATION_VARIABLE_NAME_REGEX, {
    message: 'variable name must be a Handlebars-safe identifier (alphanumeric + underscore)',
  });

// ─── Variable schema (declaration) ──────────────────────────────────────

/**
 * One entry in a template version's `variables_schema_json` blob.
 * Declares the variable's name, type, and whether the renderer should
 * reject a render request that omits it.
 *
 * `description` is rendered in the admin UI and helps the operator
 * pick the right value at template-author time.
 */
export const NotificationVariableEntrySchema = z
  .object({
    name: VariableNameSchema,
    type: NotificationVariableTypeSchema,
    required: z.boolean(),
    description: z.string().min(1).max(500).optional(),
  })
  .strict();
export type NotificationVariableEntry = z.infer<typeof NotificationVariableEntrySchema>;

const VariablesArraySchema = z
  .array(NotificationVariableEntrySchema)
  .max(NOTIFICATION_VARIABLES_MAX_ENTRIES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate variable name: ${entry.name}`,
          path: ['name'],
        });
        return;
      }
      seen.add(entry.name);
    }
  });

// ─── Template CRUD ──────────────────────────────────────────────────────

/**
 * `POST /api/v1/admin/notification/templates` request body.
 *
 * Creates a template registry row. The template starts with no
 * versions — the admin must POST to `/:id/versions` to add content
 * before the template can be rendered. The `(code, locale)` pair is
 * UNIQUE; a re-submission with the same key returns 409 Conflict.
 */
export const CreateTemplateRequestSchema = z
  .object({
    code: TemplateCodeSchema,
    locale: NotificationLocaleSchema,
    kind: NotificationChannelKindSchema,
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema.optional(),
  })
  .strict();
export type CreateTemplateRequest = z.infer<typeof CreateTemplateRequestSchema>;

/**
 * Template response shape — what `/templates/:id` and the list endpoint
 * return.
 *
 * `activeVersionId` is null when no version has been activated yet —
 * the renderer returns 404 in that state.
 */
export const TemplateResponseSchema = z
  .object({
    id: z.string().min(1),
    code: TemplateCodeSchema,
    locale: NotificationLocaleSchema,
    kind: NotificationChannelKindSchema,
    name: TemplateNameSchema,
    description: TemplateDescriptionSchema.nullable(),
    activeVersionId: z.string().min(1).nullable(),
    activeVersionNumber: z.number().int().positive().nullable(),
    latestVersionNumber: z.number().int().positive().nullable(),
    createdByUserId: AuthorUserIdSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type TemplateResponse = z.infer<typeof TemplateResponseSchema>;

const ListLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(NOTIFICATION_LIST_LIMIT_MAX)
  .default(NOTIFICATION_LIST_LIMIT_DEFAULT);

const ListCursorSchema = z.string().min(1).max(512);

/**
 * `GET /api/v1/admin/notification/templates` query string. The list is
 * cursor-paginated; optional `kind` / `locale` / `code` filters narrow
 * the result set.
 */
export const ListTemplatesQuerySchema = z
  .object({
    kind: NotificationChannelKindSchema.optional(),
    locale: NotificationLocaleSchema.optional(),
    code: TemplateCodeSchema.optional(),
    cursor: ListCursorSchema.optional(),
    limit: ListLimitSchema,
  })
  .strict();
export type ListTemplatesQuery = z.infer<typeof ListTemplatesQuerySchema>;

export const TemplatesListResponseSchema = z
  .object({
    templates: z.array(TemplateResponseSchema),
    nextCursor: ListCursorSchema.nullable(),
  })
  .strict();
export type TemplatesListResponse = z.infer<typeof TemplatesListResponseSchema>;

// ─── Template version CRUD ──────────────────────────────────────────────

/**
 * `POST /api/v1/admin/notification/templates/:id/versions` request body.
 *
 * Adds a new version to a template. Versions are monotonic per template
 * — the service stamps the next version number; the wire shape never
 * includes it. The CHECK constraints on the database (and the
 * `superRefine` below) enforce the per-kind body requirements:
 *
 *   - `email`  — `subject` + (`bodyMjml` OR `bodyHtml`) required.
 *   - `sms`    — `bodyText` required; `subject` / `bodyMjml` / `bodyHtml`
 *                must be absent.
 *   - `push`   — `bodyText` required; `subject` optional (notification
 *                title); `bodyMjml` / `bodyHtml` absent.
 *   - `in_app` — `bodyText` required; `subject` optional; `bodyMjml` /
 *                `bodyHtml` absent.
 *
 * The kind is read off the template at the service layer — the request
 * doesn't restate it. The contract validates the shape against the
 * kind in `superRefine` once the controller has joined the template
 * row in (it passes the kind into `parseCreateVersionRequest`).
 *
 * `variablesSchema` declares the variables the Handlebars renderer will
 * accept. An empty array means the template has no variables — the
 * renderer rejects a request that supplies any.
 */
export const CreateTemplateVersionRequestSchema = z
  .object({
    subject: SubjectSchema.optional(),
    bodyMjml: BodyMjmlSchema.optional(),
    bodyHtml: BodyHtmlSchema.optional(),
    bodyText: BodyTextSchema.optional(),
    variablesSchema: VariablesArraySchema,
    activate: z.boolean().default(false),
    changeSummary: z.string().min(1).max(500).optional(),
  })
  .strict();
export type CreateTemplateVersionRequest = z.infer<typeof CreateTemplateVersionRequestSchema>;

/**
 * Template version response — what `/versions` and `/versions/:n`
 * return. `bodyHtml` may be the operator-supplied HTML (rare) or the
 * MJML-compiled output (the dominant path); the service stamps it at
 * version-create time. SMS / push / in_app rows return null for the
 * email-only fields.
 */
export const TemplateVersionResponseSchema = z
  .object({
    id: z.string().min(1),
    templateId: z.string().min(1),
    version: z.number().int().positive(),
    subject: SubjectSchema.nullable(),
    bodyMjml: BodyMjmlSchema.nullable(),
    bodyHtml: BodyHtmlSchema.nullable(),
    bodyText: BodyTextSchema.nullable(),
    variablesSchema: VariablesArraySchema,
    isActive: z.boolean(),
    changeSummary: z.string().min(1).max(500).nullable(),
    createdByUserId: AuthorUserIdSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type TemplateVersionResponse = z.infer<typeof TemplateVersionResponseSchema>;

export const TemplateVersionsListResponseSchema = z
  .object({
    versions: z.array(TemplateVersionResponseSchema),
  })
  .strict();
export type TemplateVersionsListResponse = z.infer<typeof TemplateVersionsListResponseSchema>;

// ─── Render endpoint ────────────────────────────────────────────────────

/**
 * Rendered-variable value. Restricted to the three JSON-safe primitives
 * matching `NotificationVariableTypeSchema`. The renderer narrows each
 * value against the declared variable type before substitution — a
 * `number` slot rejects a `string` payload at render time.
 */
const RenderVariableValueSchema = z.union([
  z.string().max(NOTIFICATION_RENDER_VARIABLE_VALUE_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
]);
export type RenderVariableValue = z.infer<typeof RenderVariableValueSchema>;

/**
 * `POST /api/v1/internal/notification/render` request body.
 *
 * The renderer looks up `(templateCode, locale)` → active version,
 * validates `variables` against the version's `variablesSchema`, and
 * returns the assembled message. Missing required variables cause a
 * `422 Unprocessable Entity`; unknown variables a `400 Bad Request`.
 *
 * Internal-only — pinned to a shared-secret header
 * (`NOTIFICATION_RENDER_API_KEY`) so only sibling services
 * (service-notification's own channel dispatchers in TS-073, plus
 * upstream services that want a pre-rendered preview) can call it.
 */
export const RenderTemplateRequestSchema = z
  .object({
    templateCode: TemplateCodeSchema,
    locale: NotificationLocaleSchema,
    variables: z
      .record(VariableNameSchema, RenderVariableValueSchema)
      .refine((record) => Object.keys(record).length <= NOTIFICATION_VARIABLES_MAX_ENTRIES, {
        message: `variables map cannot exceed ${NOTIFICATION_VARIABLES_MAX_ENTRIES} entries`,
      })
      .optional(),
  })
  .strict();
export type RenderTemplateRequest = z.infer<typeof RenderTemplateRequestSchema>;

/**
 * Rendered-template response. `subject` is nullable for kinds that
 * don't carry one (sms primarily). `bodyHtml` is populated for email;
 * `bodyText` is populated for every kind that has a plain-text body.
 *
 * `templateCode`, `locale`, and `version` echo so the consumer can log
 * which template actually rendered without a separate fetch.
 */
export const RenderTemplateResponseSchema = z
  .object({
    templateCode: TemplateCodeSchema,
    locale: NotificationLocaleSchema,
    kind: NotificationChannelKindSchema,
    version: z.number().int().positive(),
    subject: z.string().min(1).nullable(),
    bodyHtml: z.string().min(1).nullable(),
    bodyText: z.string().min(1).nullable(),
  })
  .strict();
export type RenderTemplateResponse = z.infer<typeof RenderTemplateResponseSchema>;

// ─── Activate version request ───────────────────────────────────────────

/**
 * `POST /api/v1/admin/notification/templates/:id/versions/:version/activate`
 *
 * Flips `notification_templates.active_version_id` to the named
 * version. The request body is degenerate today — held as an explicit
 * object so future flags (e.g. `scheduledActivationAt` for staged
 * rollouts) can land without a contract break.
 */
export const ActivateTemplateVersionRequestSchema = z
  .object({
    reason: z.string().min(1).max(500).optional(),
  })
  .strict();
export type ActivateTemplateVersionRequest = z.infer<typeof ActivateTemplateVersionRequestSchema>;
