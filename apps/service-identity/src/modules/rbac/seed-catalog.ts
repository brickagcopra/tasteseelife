import { SYSTEM_ROLE_NAMES, type SystemRoleName } from '@taste-and-see/auth-sdk';

/**
 * RBAC seed catalog (PDD §10.2 + Appendix B; CLAUDE.md §3.2).
 *
 * The single source of truth for the system role + permission graph.
 * `seedRbacCatalog` (see `seed.ts`) reads this module and idempotently
 * upserts the rows into `identity.permissions`, `identity.roles`, and
 * `identity.role_permissions` so a freshly-applied schema arrives at a
 * known-good RBAC posture without manual SQL.
 *
 * Adding a permission is a code change here plus a re-seed; the
 * upserts make the operation safe to run repeatedly. Removing a
 * permission is intentional friction — it must go through the admin
 * RBAC tooling (TS-290) so an audit event is recorded; the seed
 * function does NOT delete rows it doesn't own.
 *
 * The permission set seeded here mirrors PDD Appendix B exactly (the
 * eight permissions Appendix B enumerates), plus `finance:adjust` which
 * CLAUDE.md §6 names as the gate for re-opening a closed accounting
 * period, plus `concierge:read` / `concierge:write` which gate the
 * concierge ops console (TS-224; PRD §10.6 — granted to super_admin +
 * concierge_lead for write, operations_manager for read), plus
 * `academy:read` / `academy:write` which gate the Cooking Academy
 * course-catalog admin surface (TS-251; PRD §9.5 — write granted to
 * super_admin + content_editor as the curriculum-authoring persona, read
 * additionally to operations_manager), plus `ads:read` / `ads:write` which
 * gate the ads campaign admin surface (TS-271; PRD §10.9 / PDD §18.1 —
 * granted to super_admin + marketing as the campaign-managing persona),
 * plus `marketing:approve_creative` which gates the creative review / approval
 * queue (TS-277; PRD §10.9 / PDD §18.3 — a separate, higher-trust gate than
 * ads:write so the campaign author cannot self-approve; granted to super_admin
 * + marketing), plus `rbac:read` / `rbac:write` which gate the RBAC admin
 * tooling itself (TS-290; PRD §10.12 / PDD §10.3 — write granted to
 * super_admin only; read additionally to read_only_auditor so an auditor can
 * review the role/permission graph), plus `trust_safety:read` /
 * `trust_safety:write` which gate the incident queue and the elder-abuse
 * mandated-reporter pathway (TS-303b / TS-303c1; PRD §10.14, §11.4 / PDD
 * §16.1, §16.4 — granted to super_admin + the `trust_safety` role ONLY; the
 * four-eyes signoff needs two holders, but widening it further would put a
 * legal determination in reach of untrained staff).
 * Customer-facing
 * roles (`family_payer`, `senior_user`, …) are
 * seeded with empty permission sets — their gating semantics live at
 * the consuming services' call sites for Phase 1; finer permissions
 * arrive as those services land.
 */

/**
 * Catalog of every permission the platform recognises today. The
 * `(resource, action)` pair is unique and is what `seedRbacCatalog`
 * upserts on. `description` shows up in admin RBAC tooling.
 */
export const PERMISSION_CATALOG = [
  {
    resource: 'user',
    action: 'read',
    description: 'View user account records (PDD Appendix B).',
  },
  {
    resource: 'user',
    action: 'suspend',
    description: 'Suspend or reinstate user accounts (PDD Appendix B).',
  },
  {
    resource: 'user',
    action: 'impersonate',
    description:
      'Mint a diagnostic impersonation session in a user’s name (TS-297; PRD §10.2). Start and end are audit-logged with the operator identity preserved. Phase 1: super_admin only.',
  },
  {
    resource: 'subscription',
    action: 'write',
    description:
      'Create, modify, comp, prorate, or cancel subscriptions on behalf of a customer (PDD Appendix B; CLAUDE.md §6 — money mutations require this gate).',
  },
  {
    resource: 'accounting',
    action: 'close_period',
    description:
      'Close or reopen an accounting period; reopen is reviewer-required (PDD §11.2; CLAUDE.md §6).',
  },
  {
    resource: 'finance',
    action: 'adjust',
    description:
      'Post manual adjustment / reversal journals into the ledger (CLAUDE.md §6 — required for any out-of-period write or refund-without-event).',
  },
  {
    resource: 'provider',
    action: 'approve',
    description: 'Approve or reject provider applications and tier promotions (PDD Appendix B).',
  },
  {
    resource: 'provider',
    action: 'read',
    description:
      "Read another provider's admin dossier — profile, full certification history, tier transitions, background-check verdict (TS-305a). Split out from `provider:approve` because that permission is a WRITE authority: gating a read on it would mean everyone allowed to look at a provider is also allowed to revoke their credentials, and the trust_safety role — the review committee the dossier exists for — does not hold it.",
  },
  {
    resource: 'coupon',
    action: 'create',
    description:
      'Create coupon codes and promotional bundles (PDD Appendix B; CLAUDE.md §12 — coupon abuse prevention applies at the booking layer).',
  },
  {
    resource: 'content',
    action: 'publish',
    description: 'Publish blog posts, help-center articles, or static pages (PDD Appendix B).',
  },
  {
    resource: 'audit',
    action: 'read',
    description:
      'Read the audit log (PDD Appendix B; CLAUDE.md §3.6 — append-only with hash chaining).',
  },
  {
    resource: 'concierge',
    action: 'read',
    description:
      'Read the concierge ops queue, ticket details, and internal notes (TS-224 ops console; PRD §10.6).',
  },
  {
    resource: 'concierge',
    action: 'write',
    description:
      'Transition concierge ticket status, escalate, and add internal notes on the ops console (TS-224; PRD §10.6).',
  },
  {
    resource: 'academy',
    action: 'read',
    description:
      'Read the Cooking Academy course catalog admin surface — courses, modules, lessons, cohorts (TS-251; PRD §9.5).',
  },
  {
    resource: 'academy',
    action: 'write',
    description:
      'Create / edit / archive Cooking Academy courses and manage modules, lessons, and cohorts (TS-251; PRD §9.5 admin curriculum management).',
  },
  {
    resource: 'ads',
    action: 'read',
    description:
      'Read the ads campaign admin surface — campaigns, creatives, targeting rules (TS-271; PRD §10.9 / PDD §18.1).',
  },
  {
    resource: 'ads',
    action: 'write',
    description:
      'Create / edit / archive ad campaigns and manage their creatives + targeting rules (TS-271; PRD §10.9 / PDD §18.1). Creative approval / compliance review (marketing:approve_creative) is a separate gate — TS-277.',
  },
  {
    resource: 'marketing',
    action: 'approve_creative',
    description:
      'Approve / reject partner-submitted ad creatives in the review queue, with accessibility + disclosure-compliance review (TS-277; PRD §10.9 / PDD §18.3). A separate, higher-trust gate than ads:write — the campaign author cannot self-approve their own creatives.',
  },
  {
    resource: 'rbac',
    action: 'read',
    description:
      'Read the RBAC catalog — roles, their permission sets, and the permission list (TS-290 admin tooling; PRD §10.12 / PDD §10.3).',
  },
  {
    resource: 'rbac',
    action: 'write',
    description:
      'Create / edit / archive CUSTOM roles and manage their permission sets via the RBAC admin tooling (TS-290; PRD §10.12 / PDD §10.3). System roles remain seed-owned and read-only regardless of this permission.',
  },
  {
    resource: 'trust_safety',
    action: 'read',
    description:
      'Read the trust & safety incident queue and its case detail (TS-303; PRD §10.14 / PDD §16.1).',
  },
  {
    resource: 'trust_safety',
    action: 'write',
    description:
      'Run the trust & safety workflows: open / advance / sign off mandated-reporter cases, maintain the per-state jurisdiction kit, and resolve incidents (TS-303b / TS-303c1; PRD §10.14, §11.4 / PDD §16.1, §16.4; CLAUDE.md §12). This is the gate on the elder-abuse statutory pathway — including the four-eyes signoff that releases an incident for closure — so it is granted narrowly.',
  },
  {
    resource: 'privacy',
    action: 'read',
    description:
      'Read the data-subject request queue and its detail — the Privacy Center operator view (TS-309a; PRD §11.4 / PDD §16.3, §16.4). The detail carries who asked, about whom, and how their identity was established, so it is a narrower grant than it looks.',
  },
  {
    resource: 'privacy',
    action: 'write',
    description:
      "Act on a data-subject request: record that a requester has been verified as entitled to act for the subject, refuse a request with a categorical reason, and take the single permitted statutory extension (TS-309a; PRD §11.4 / PDD §16.3; CLAUDE.md §3.6, §12). Verification is what releases a request about SOMEBODY ELSE — most often a family member asking about a senior — so this is the gate on handing one person another person's data.",
  },
  {
    resource: 'media',
    action: 'read',
    description:
      "Resolve a media assetKey into a short-lived signed preview URL on an admin console (TS-282-followup-5b; CLAUDE.md §3.4). Closes a live defect: TS-277a gates ad-creative approval on an accessibility review — alt text, WCAG contrast, motion — and the reviewer was approving against a list of opaque strings. The permission is NOT the whole control: the resolution surface additionally refuses by asset kind (`isAdminPreviewableMediaKind`), because a senior's photograph, a provider's identity document and a background-check evidence PDF live in the same store as an ad banner, and none of the personas holding this permission has any business seeing them.",
  },
] as const satisfies ReadonlyArray<{
  readonly resource: string;
  readonly action: string;
  readonly description: string;
}>;

/**
 * Permission identifier as it appears in `RoleAssignment.permissions`
 * (and thus in the access-token `roles[*].permissions[*]` claim).
 * Always `resource:action`.
 */
export type SeedPermissionString =
  `${(typeof PERMISSION_CATALOG)[number]['resource']}:${(typeof PERMISSION_CATALOG)[number]['action']}`;

/**
 * Format a catalog entry into its canonical `resource:action` string.
 */
export function formatPermission(entry: {
  readonly resource: string;
  readonly action: string;
}): string {
  return `${entry.resource}:${entry.action}`;
}

/**
 * Roles whose grant requires reviewer signoff (CLAUDE.md §3.2 —
 * privilege escalation for sensitive roles). NOT grantable via the
 * admin assignment surface (TS-292) — they take the reviewer-approval
 * flow (TS-294, on the TS-024-followup-4 `role_assignment_approvals`
 * model). The contracts package mirrors this list as
 * `ADMIN_ROLE_ASSIGNMENTS_SENSITIVE_ROLES` for UI affordances; a unit
 * test pins the two together against drift.
 */
export const SENSITIVE_ROLE_NAMES = [
  'super_admin',
  'finance',
] as const satisfies readonly SystemRoleName[];

/**
 * Catalog of every system role. Each entry lists the permissions
 * that role holds — drawn from PDD Appendix B for admin roles and
 * left empty for customer-facing roles (the consuming services'
 * call-site checks gate those for Phase 1).
 *
 * Permissions are listed by `resource:action` string; the seed
 * function resolves them against `PERMISSION_CATALOG` by id.
 *
 * `description` shows up in admin RBAC tooling (TS-290).
 */
export const ROLE_CATALOG = [
  // ── Customer-facing roles (PDD §10.2). Permission sets are empty
  //    in Phase 1 — service-side call-site checks gate the
  //    customer-facing actions until those services land their own
  //    permission declarations.
  {
    name: 'family_payer',
    description: 'Adult-child paying customer; owns the household subscription.',
    permissions: [],
  },
  {
    name: 'family_observer',
    description: "Family member with read-only visibility into a senior's household activity.",
    permissions: [],
  },
  {
    name: 'senior_user',
    description: 'End-user senior account holder; senior-mode UI applies.',
    permissions: [],
  },
  {
    name: 'provider',
    description: 'Chef, caregiver, or culinary companion delivering bookings.',
    permissions: [],
  },
  {
    name: 'partner_admin',
    description: 'Administrator at a partner residence / healthcare org / employer.',
    permissions: [],
  },
  {
    name: 'partner_member',
    description: 'Non-admin staff member at a partner organisation.',
    permissions: [],
  },
  {
    name: 'student',
    description: 'Cooking Academy enrollee.',
    permissions: [],
  },
  // ── Admin roles (PDD §10.2 + Appendix B). Permission sets are
  //    drawn directly from the Appendix B matrix; finance:adjust is
  //    additionally granted to super_admin + finance per CLAUDE.md
  //    §6 (period close / reopen).
  {
    name: 'super_admin',
    description: 'Full platform privileges. MFA mandatory.',
    permissions: [
      'user:read',
      'user:suspend',
      'user:impersonate',
      'subscription:write',
      'accounting:close_period',
      'finance:adjust',
      'provider:approve',
      'provider:read',
      'coupon:create',
      'content:publish',
      'audit:read',
      'concierge:read',
      'concierge:write',
      'academy:read',
      'academy:write',
      'ads:read',
      'ads:write',
      'marketing:approve_creative',
      'rbac:read',
      'rbac:write',
      'trust_safety:read',
      'trust_safety:write',
      'privacy:read',
      'privacy:write',
      'media:read',
    ],
  },
  {
    name: 'operations_manager',
    description: 'Senior ops staff. Read-broad, write on user + subscription escalation paths.',
    permissions: [
      'user:read',
      'user:suspend',
      'subscription:write',
      'audit:read',
      'concierge:read',
      'academy:read',
      // TS-305a — read-only visibility into a provider's dossier. Ops
      // triages provider-related tickets and needs to see credentials
      // and tier history; `provider:approve` (granting a certification,
      // overriding a tier) stays with provider_ops.
      'provider:read',
      // TS-309a — ops works the data-subject request queue. Granted BOTH
      // halves rather than read-only: a statutory queue with a 45-day clock
      // that only `super_admin` can act on is a queue that misses its
      // deadline the first week someone is on leave. The narrower reading —
      // that verifying a family member's entitlement to a senior's data is a
      // judgement for a compliance function rather than ops — is the right
      // one the moment such a function exists; until then, one holder is
      // worse than a wide one.
      'privacy:read',
      'privacy:write',
    ],
  },
  {
    name: 'customer_support',
    description: 'Front-line support; read-only on most surfaces.',
    permissions: ['user:read'],
  },
  {
    name: 'concierge_lead',
    description:
      'Concierge supervisor; reads users for ticket triage and works the concierge ops queue (TS-224).',
    permissions: ['user:read', 'concierge:read', 'concierge:write'],
  },
  {
    name: 'provider_ops',
    description: 'Provider operations team — reviews applications, manages tiers.',
    permissions: ['user:read', 'provider:approve', 'provider:read'],
  },
  {
    name: 'finance',
    description: 'Finance / accounting team; gates the period-close + adjust workflows.',
    permissions: [
      'user:read',
      'subscription:write',
      'accounting:close_period',
      'finance:adjust',
      'audit:read',
    ],
  },
  {
    name: 'marketing',
    description:
      'Marketing team; manages coupons + ad campaigns, and approves submitted creatives.',
    permissions: [
      'user:read',
      'coupon:create',
      'ads:read',
      'ads:write',
      'marketing:approve_creative',
      // TS-282-followup-5b — without this the creative reviewer approves
      // accessibility against a list of opaque asset keys, which is exactly
      // what `marketing:approve_creative` was written to prevent.
      'media:read',
    ],
  },
  {
    name: 'content_editor',
    description: 'Blog / CMS / Help Center editor; authors the Cooking Academy curriculum.',
    // TS-282-followup-5b — `media:read` so the author editor and the article
    // SEO fields render their referenced imagery rather than a key string.
    permissions: ['content:publish', 'academy:read', 'academy:write', 'media:read'],
  },
  {
    name: 'trust_safety',
    description:
      'Trust & Safety; user reads + suspensions + audit visibility, and the incident / mandated-reporter workflows.',
    // `trust_safety:write` gates the elder-abuse statutory pathway (TS-303b /
    // TS-303c1) — opening and signing off mandated-reporter cases, maintaining
    // the per-state jurisdiction kit, and closing incidents. Granted here and
    // to super_admin ONLY: the four-eyes signoff needs two holders of this
    // permission, but widening it further (to operations_manager, say) would
    // put a legal determination in reach of staff who are not trained for it.
    permissions: [
      'user:read',
      'user:suspend',
      'audit:read',
      'trust_safety:read',
      'trust_safety:write',
      // TS-305a — the Provider 360 review surface. Read-only: the
      // committee deliberates and records an incident outcome; changing
      // a provider's tier or credentials is provider_ops' act, taken on
      // the committee's finding. Two roles, one decision each.
      'provider:read',
    ],
  },
  {
    name: 'read_only_auditor',
    description: 'Auditor / external reviewer; read-only across user + audit surfaces.',
    // rbac:read — an auditor reviewing "who can do what" needs the role/
    // permission graph visible (TS-290); write stays super_admin-only.
    permissions: ['user:read', 'audit:read', 'rbac:read'],
  },
] as const satisfies ReadonlyArray<{
  readonly name: SystemRoleName;
  readonly description: string;
  readonly permissions: readonly string[];
}>;

/**
 * Compile-time guard: every catalog name must be a `SystemRoleName`,
 * and every `SystemRoleName` must appear in `ROLE_CATALOG`. The two
 * checks together prevent drift between the auth-sdk constant and the
 * service-side seed catalog.
 *
 * Implemented via a typed exhaustiveness map — TypeScript fails the
 * build if either side gains or loses an entry.
 */
const _ROLE_CATALOG_NAMES: readonly SystemRoleName[] = ROLE_CATALOG.map((r) => r.name);
const _ROLE_CATALOG_NAMES_LOOKUP: Record<SystemRoleName, true> = Object.fromEntries(
  _ROLE_CATALOG_NAMES.map((n) => [n, true]),
) as Record<SystemRoleName, true>;
for (const expected of SYSTEM_ROLE_NAMES) {
  if (_ROLE_CATALOG_NAMES_LOOKUP[expected] !== true) {
    throw new Error(
      `RBAC catalog drift: SYSTEM_ROLE_NAMES includes "${expected}" but ROLE_CATALOG does not seed it`,
    );
  }
}
