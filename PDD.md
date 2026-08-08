# Taste & See — Product Design Document (PDD)

**Document Version:** 1.0
**Status:** Draft for Engineering Review
**Last Updated:** 2026-05-07
**Owner:** Engineering Architecture
**Companion Document:** `PRD.md`

---

## 1. Purpose

This document specifies the technical architecture, system design, data models, and infrastructure for the Taste & See platform. It is the blueprint that translates the PRD into engineering execution. Where the PRD specifies _what_ and _why_, this PDD specifies _how_.

---

## 2. Architectural Principles

1. **Service decomposition by bounded context** — each business domain owns its data and exposes contract APIs.
2. **Polyglot persistence** — PostgreSQL for transactional integrity, Cassandra for high-volume time-series and chat workloads, Redis for cache and ephemeral state, S3-compatible object storage for media.
3. **Event-driven communication** — domain events published to a message bus enable asynchronous workflows (notifications, accounting entries, analytics).
4. **Async-first** — long-running and externally-coupled work runs in BullMQ workers, never inline in HTTP handlers.
5. **Observability is first-class** — structured logs, traces, and metrics from day one.
6. **Security and compliance by design** — least-privilege access, encryption everywhere, audit trails on every state change.
7. **Multi-tenancy isolation** — partner organizations and admin staff scopes are tenant-scoped at the data and middleware layer.
8. **Twelve-factor** configuration, statelessness, and immutability.
9. **Trunk-based development** with environment-promoted releases and feature flags.

---

## 3. Tech Stack Summary

| Layer                                                             | Technology                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------- |
| Frontend Web (Marketing, Family/Senior, Provider, Partner, Admin) | Next.js 15 (App Router) + React 19 + Tailwind CSS + Shadcn/ui   |
| State Management                                                  | Zustand for client state, TanStack Query for server state       |
| Backend Services                                                  | NestJS 11 (TypeScript), one service per bounded context         |
| Primary Datastore                                                 | PostgreSQL 16 with Prisma ORM                                   |
| Wide-column / High-Volume Store                                   | Apache Cassandra 5.x                                            |
| Cache & Ephemeral                                                 | Redis 7.x (with RedisJSON / RediSearch where applicable)        |
| Search                                                            | Elasticsearch / OpenSearch (provider discovery, content search) |
| Job Queue                                                         | BullMQ on Redis                                                 |
| Object Storage                                                    | S3-compatible (AWS S3 or equivalent)                            |
| Email                                                             | Postmark / SendGrid / AWS SES                                   |
| SMS                                                               | Twilio                                                          |
| Push                                                              | APNs + FCM via Firebase or OneSignal                            |
| Payments                                                          | Stripe (Subscriptions, Connect for provider payouts, Tax)       |
| KYC / Background                                                  | Stripe Identity + Checkr                                        |
| Maps & Routing                                                    | Mapbox or Google Maps Platform                                  |
| Video (virtual family meal)                                       | Daily.co / Twilio Video / LiveKit                               |
| Real-time                                                         | WebSockets via Socket.IO with Redis adapter                     |
| Container Runtime                                                 | Docker                                                          |
| Orchestration                                                     | Kubernetes (managed: AKS / EKS / GKE)                           |
| Service Mesh                                                      | Istio or Linkerd (optional Phase 2)                             |
| Ingress                                                           | NGINX Ingress / Traefik + AWS ALB / Azure Front Door            |
| Observability                                                     | OpenTelemetry → Prometheus + Grafana + Loki + Tempo             |
| Error Tracking                                                    | Sentry                                                          |
| CI/CD                                                             | GitHub Actions + ArgoCD                                         |
| IaC                                                               | Terraform                                                       |
| Secrets                                                           | HashiCorp Vault / AWS Secrets Manager / Azure Key Vault         |
| Feature Flags                                                     | Unleash / LaunchDarkly                                          |
| Repository Layout                                                 | Turborepo + pnpm monorepo                                       |

---

## 4. Logical System Architecture

### 4.1 High-Level Topology

```
                 ┌──────────────────────────────────────────────────┐
                 │                  Edge / CDN                       │
                 │  CloudFront / Azure Front Door + WAF + DDoS       │
                 └──────────────────────────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 │                                           │
        ┌────────▼─────────┐                       ┌─────────▼──────┐
        │   Next.js Apps   │                       │   API Gateway   │
        │ (SSR/ISR/RSC)    │                       │  (NestJS BFF)   │
        │ marketing,       │                       │ Auth, rate-     │
        │ family, provider,│◄──────────────────────│ limit, schema   │
        │ partner, admin   │                       │ validation      │
        └──────────────────┘                       └──────┬─────────┘
                                                          │
                              ┌───────────────────────────┼──────────────────────────┐
                              │                           │                          │
                     ┌────────▼─────────┐        ┌────────▼─────────┐       ┌────────▼─────────┐
                     │ Identity & Auth  │        │ Subscriptions    │       │ Bookings &       │
                     │ Service          │        │ & Billing        │       │ Marketplace      │
                     └────────┬─────────┘        └────────┬─────────┘       └────────┬─────────┘
                              │                           │                          │
                     ┌────────▼─────────┐        ┌────────▼─────────┐       ┌────────▼─────────┐
                     │ Provider         │        │ Concierge &      │       │ Messaging &      │
                     │ Operations       │        │ Service Catalog  │       │ Notifications    │
                     └──────────────────┘        └──────────────────┘       └──────────────────┘

                     ┌──────────────────┐        ┌──────────────────┐       ┌──────────────────┐
                     │ Academy &        │        │ Accounting &     │       │ Content & CMS    │
                     │ Certifications   │        │ Ledger           │       │                  │
                     └──────────────────┘        └──────────────────┘       └──────────────────┘

                     ┌──────────────────┐        ┌──────────────────┐       ┌──────────────────┐
                     │ Partner Org      │        │ Ads & Promotions │       │ Admin & RBAC     │
                     │ (Enterprise)     │        │                  │       │ + Audit Log      │
                     └──────────────────┘        └──────────────────┘       └──────────────────┘

                     ┌──────────────────┐        ┌──────────────────┐
                     │ Trust & Safety   │        │ Analytics &      │
                     │                  │        │ Reporting        │
                     └──────────────────┘        └──────────────────┘

         Datastores:  PostgreSQL  |  Cassandra  |  Redis  |  Elasticsearch  |  S3
         Async:       BullMQ Workers   ◀───── Event Bus (Redis Streams / Kafka Phase 3)
```

### 4.2 Service Inventory

| #   | Service            | Responsibility                                                                 | Primary Store               |
| --- | ------------------ | ------------------------------------------------------------------------------ | --------------------------- |
| 1   | `gateway-api`      | BFF for all client apps, GraphQL or REST aggregation, auth context propagation | —                           |
| 2   | `identity-svc`     | User accounts, sessions, JWT issuance, MFA, KYC, role assignments              | PostgreSQL                  |
| 3   | `household-svc`    | Senior households, family members, dietary/cultural preferences                | PostgreSQL                  |
| 4   | `provider-svc`     | Provider profiles, certifications, tiers, search index sync                    | PostgreSQL + ES             |
| 5   | `subscription-svc` | Plans, subscriptions, billing cycles, dunning, coupons                         | PostgreSQL + Stripe         |
| 6   | `booking-svc`      | Booking lifecycle, availability, scheduling, recurring bookings                | PostgreSQL                  |
| 7   | `concierge-svc`    | Concierge tickets, queues, SLAs, custom service requests                       | PostgreSQL                  |
| 8   | `messaging-svc`    | Threads, messages, attachments, real-time delivery                             | Cassandra + Redis pub/sub   |
| 9   | `notification-svc` | Email, SMS, push templating + delivery, preferences                            | PostgreSQL + queues         |
| 10  | `accounting-svc`   | Double-entry ledger, journal entries, reports                                  | PostgreSQL                  |
| 11  | `payouts-svc`      | Stripe Connect orchestration, provider payout schedule, 1099 prep              | PostgreSQL + Stripe         |
| 12  | `academy-svc`      | Courses, lessons, enrollments, certifications, cohorts                         | PostgreSQL                  |
| 13  | `content-svc`      | Blog, CMS pages, help center articles, legal docs versioning                   | PostgreSQL                  |
| 14  | `ads-svc`          | Campaigns, placements, targeting, frequency, attribution                       | PostgreSQL + ES             |
| 15  | `partner-svc`      | Partner orgs, residential rosters, enterprise contracts                        | PostgreSQL                  |
| 16  | `trust-safety-svc` | Reports, escalations, welfare flags, audit                                     | PostgreSQL                  |
| 17  | `analytics-svc`    | Read-side aggregations, dashboards, scheduled reports                          | PostgreSQL + Cassandra read |
| 18  | `audit-svc`        | Append-only audit log, admin action capture                                    | Cassandra                   |
| 19  | `activity-svc`     | User activity stream, session/login history                                    | Cassandra                   |
| 20  | `media-svc`        | Signed-URL issuance, file uploads, image processing pipeline                   | S3 + PostgreSQL metadata    |
| 21  | `search-svc`       | Cross-domain search, ES query orchestration                                    | Elasticsearch               |
| 22  | `webhook-svc`      | Inbound webhook receivers (Stripe, Checkr, Twilio, etc.)                       | PostgreSQL                  |

Each service runs as an independent NestJS application, deployable on its own cadence, with its own dedicated PostgreSQL schema (logical isolation; option to physically split per database in Phase 3).

---

## 5. Repository Layout

A Turborepo + pnpm monorepo:

```
taste-and-see/
├── apps/
│   ├── web-marketing/             # Next.js public marketing site
│   ├── web-family/                # Family / senior portal (Next.js)
│   ├── web-provider/              # Provider portal (Next.js)
│   ├── web-partner/               # Partner / enterprise portal
│   ├── web-admin/                 # Internal admin panel
│   ├── web-academy/               # Cooking Academy LMS
│   ├── api-gateway/               # NestJS BFF
│   ├── service-identity/
│   ├── service-household/
│   ├── service-provider/
│   ├── service-subscription/
│   ├── service-booking/
│   ├── service-concierge/
│   ├── service-messaging/
│   ├── service-notification/
│   ├── service-accounting/
│   ├── service-payouts/
│   ├── service-academy/
│   ├── service-content/
│   ├── service-ads/
│   ├── service-partner/
│   ├── service-trust-safety/
│   ├── service-analytics/
│   ├── service-audit/
│   ├── service-activity/
│   ├── service-media/
│   ├── service-search/
│   ├── service-webhook/
│   └── workers/
│       ├── billing-worker/
│       ├── notification-worker/
│       ├── accounting-worker/
│       ├── search-indexer/
│       ├── analytics-aggregator/
│       └── media-processor/
├── packages/
│   ├── ui/                        # Shadcn-based shared component lib
│   ├── design-tokens/
│   ├── eslint-config/
│   ├── tsconfig/
│   ├── prisma-schemas/            # Per-service schemas
│   ├── contracts/                 # OpenAPI / GraphQL SDL / Zod schemas
│   ├── types/                     # Shared TypeScript types
│   ├── auth-sdk/                  # JWT, RBAC, tenant scoping
│   ├── feature-flags/
│   ├── logger/                    # Structured logging
│   ├── tracing/                   # OpenTelemetry helpers
│   ├── messaging/                 # Event bus client
│   └── testing/
├── infra/
│   ├── docker/
│   ├── kubernetes/
│   │   ├── base/
│   │   ├── overlays/{dev,staging,prod}/
│   │   └── helm-charts/
│   ├── terraform/
│   └── argocd/
└── docs/
    ├── PRD.md
    ├── PDD.md
    ├── CLAUDE.md
    └── adrs/                      # Architecture Decision Records
```

---

## 6. Frontend Architecture

### 6.1 Application Boundaries

- **web-marketing** — public-facing brand site, blog reader, conversion entry point
- **web-family** — authenticated experience for paying families and seniors; senior-mode UI variant
- **web-provider** — authenticated experience for chefs/caregivers
- **web-partner** — enterprise dashboard for partner organizations
- **web-admin** — internal staff console with strict RBAC
- **web-academy** — LMS for course consumption (shared roots between provider students and external students)

All apps are Next.js 15 with the App Router, leveraging Server Components by default and Client Components for interactive surfaces. Shared UI primitives live in `packages/ui` and are consumed across apps.

### 6.2 Key Frontend Patterns

- **Authentication** — HttpOnly cookie sessions issued by `identity-svc`, refreshed via rotating refresh tokens with reuse detection
- **Authorization** — RBAC claims propagated to RSC via cookie + decoded server-side
- **Data fetching** — TanStack Query in client components; direct fetch in RSC
- **Form handling** — React Hook Form + Zod validation
- **Theming** — Tailwind + CSS variables, per-app theme overrides, senior-mode high-contrast variant
- **Internationalization** — `next-intl` ready for Phase 2 multilingual rollout
- **Accessibility** — WCAG 2.2 AA enforced by axe-linter and CI Lighthouse budget

### 6.3 Senior-Mode UI

Optional flag on senior accounts that toggles:

- 1.5× base font size
- WCAG AAA contrast pairs
- Reduced motion
- Larger tap targets (48px minimum)
- Simplified navigation drawer
- Voice-readable transcripts

---

## 7. Backend Architecture (NestJS Services)

### 7.1 Standard Service Layout

Each service follows a consistent NestJS structure:

```
service-foo/
├── src/
│   ├── app.module.ts
│   ├── main.ts
│   ├── config/
│   ├── common/                # filters, guards, pipes, interceptors
│   ├── modules/
│   │   ├── domain-a/
│   │   │   ├── controllers/
│   │   │   ├── services/
│   │   │   ├── repositories/
│   │   │   ├── dtos/
│   │   │   ├── events/
│   │   │   └── domain-a.module.ts
│   │   └── ...
│   ├── prisma/
│   ├── messaging/             # event bus producers/consumers
│   ├── health/
│   └── observability/
├── prisma/schema.prisma
├── test/
└── Dockerfile
```

### 7.2 Cross-Cutting Concerns

- **Auth Guard** — verifies JWT, attaches `requestContext` (userId, role, tenantId)
- **Tenant Scoping Middleware** — enforces query-time tenant filters via Prisma extension
- **Validation Pipe** — global `class-validator` + Zod schema validation
- **Audit Interceptor** — emits audit events on mutating endpoints to `audit-svc`
- **Idempotency Middleware** — checks `Idempotency-Key` header for write endpoints
- **Rate Limit Guard** — Redis-backed sliding window
- **Request Tracing** — OpenTelemetry SDK with `traceId` propagation

### 7.3 Inter-Service Communication

- **Sync calls** — gRPC for low-latency intra-cluster service-to-service; REST/HTTPS through gateway for client apps
- **Async events** — domain events published to event bus (Redis Streams initially, Kafka by Phase 3)
- **Outbox pattern** — services write event records to local DB transaction, a relay process publishes to bus, ensuring exactly-once-effective delivery
- **Webhooks** — outbound to partners and inbound from third parties handled by `webhook-svc`

### 7.4 Event Catalog (selected)

| Event                         | Publisher        | Consumers                                        |
| ----------------------------- | ---------------- | ------------------------------------------------ |
| `subscription.activated`      | subscription-svc | accounting, notification, analytics              |
| `subscription.canceled`       | subscription-svc | accounting, notification, analytics              |
| `subscription.payment_failed` | subscription-svc | notification, analytics                          |
| `booking.created`             | booking-svc      | notification, analytics                          |
| `booking.confirmed`           | booking-svc      | notification, accounting (reservation), provider |
| `booking.completed`           | booking-svc      | accounting, payouts, notification, analytics     |
| `booking.canceled`            | booking-svc      | accounting, notification, analytics              |
| `provider.tier_changed`       | provider-svc     | search-indexer, notification, accounting         |
| `payout.disbursed`            | payouts-svc      | accounting, notification                         |
| `coupon.redeemed`             | subscription-svc | accounting, analytics                            |
| `welfare.flagged`             | trust-safety-svc | notification, admin                              |
| `course.completed`            | academy-svc      | provider-svc, notification                       |
| `audit.action_recorded`       | (any service)    | audit-svc                                        |

---

## 8. Data Architecture

### 8.1 Datastore Selection Rationale

| Workload                                                                        | Store             | Why                                                                                  |
| ------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| Transactional core (users, subscriptions, bookings, billing, accounting ledger) | **PostgreSQL**    | ACID, foreign keys, complex queries, double-entry integrity                          |
| Audit logs, activity events, message threads, notification history              | **Cassandra**     | Massive append-only writes, time-series queries by partition key, linear scalability |
| Caches, sessions, rate limits, ephemeral state, BullMQ                          | **Redis**         | Sub-millisecond, TTLs, pub/sub                                                       |
| Provider, content, blog, help center search                                     | **Elasticsearch** | Full-text relevance, faceting, geo-search                                            |
| Photos, documents, certificates, video assets                                   | **S3**            | Durable object storage, signed URLs, CDN integration                                 |

### 8.2 PostgreSQL Schema (selected core tables)

Each service owns its schema. Cross-service references are by ID only — no foreign keys across service boundaries.

#### `identity` schema

```
users(id, email, phone, password_hash, status, mfa_enabled, created_at, ...)
sessions(id, user_id, refresh_token_hash, ip, user_agent, expires_at, revoked_at)
roles(id, name, description, is_system)
permissions(id, resource, action, description)
role_permissions(role_id, permission_id)
user_roles(user_id, role_id, scope_type, scope_id, granted_by, expires_at)
mfa_methods(id, user_id, kind, secret_encrypted, last_used_at)
kyc_records(id, user_id, provider, status, payload_encrypted, verified_at)
```

#### `household` schema

```
households(id, primary_payer_user_id, address, time_zone, status, created_at)
household_members(id, household_id, user_id, role)  -- family observer / payer
seniors(id, household_id, first_name, last_name, dob, dietary, allergies, dementia_status, mobility, languages, ...)
senior_preferences(senior_id, key, value)
emergency_contacts(id, household_id, name, phone, relationship)
memory_recipes(id, senior_id, title, description, source, image_key, ...)
```

#### `provider` schema

```
providers(id, user_id, status, tier, bio, profile_photo_key, video_intro_key, ...)
provider_certifications(id, provider_id, certification_id, issued_at, expires_at)
provider_specialties(provider_id, specialty)
provider_languages(provider_id, language)
provider_service_areas(id, provider_id, geo_polygon)
provider_availability(id, provider_id, weekday, start_time, end_time)
provider_documents(id, provider_id, kind, file_key, uploaded_at, reviewed_at)
provider_metrics(provider_id, rating_avg, completion_rate, response_time_p50, ...)
```

#### `subscription` schema

```
plans(id, code, name, customer_group, monthly_price, annual_price, features_json, active)
subscriptions(id, customer_id, customer_group, plan_id, status, period_start, period_end, trial_end, stripe_subscription_id, ...)
subscription_history(id, subscription_id, event, from_status, to_status, occurred_at, actor_id)
coupons(id, code, kind, amount, applies_to_plan_ids, max_redemptions, expires_at, ...)
coupon_redemptions(id, coupon_id, customer_id, subscription_id, redeemed_at, value_applied)
invoices(id, subscription_id, stripe_invoice_id, total, tax, status, issued_at, paid_at, ...)
invoice_line_items(id, invoice_id, kind, description, amount, period_start, period_end)
payment_methods(id, customer_id, kind, stripe_pm_id, last4, brand, default)
```

#### `booking` schema

```
bookings(id, household_id, senior_id, provider_id, service_kind, status, scheduled_start, scheduled_end, base_price, commission_rate, commission_amount, final_price, ...)
booking_recurrence(id, booking_id, rrule, end_date)
booking_visit_notes(id, booking_id, mood, appetite, hydration, social_engagement, freeform, photos_keys[])
booking_check_ins(id, booking_id, kind, occurred_at, latitude, longitude)
booking_disputes(id, booking_id, opened_by, reason, status, resolution_notes, resolved_at)
service_catalog(id, kind, name, base_rate_min, base_rate_max, duration_minutes, description)
```

#### `accounting` schema (double-entry)

```
chart_of_accounts(id, code, name, type, parent_id, normal_balance)
journals(id, kind, occurred_at, source_event_id, description, posted_at, reversed_by)
journal_lines(id, journal_id, account_id, debit, credit, currency, memo)
periods(id, name, start_date, end_date, status)  -- open / closed
provider_payable_balances(provider_id, currency, amount)
deferred_revenue_balances(subscription_id, amount, period_start, period_end)
saas_metrics_daily(date, mrr, arr, arpu, active_subs, churn_count, expansion_mrr, contraction_mrr)
```

Journal entries are immutable. Corrections are made via reversal journals plus replacement journals, fully traceable.

#### `messaging` schema (PostgreSQL metadata)

```
threads(id, kind, household_id, booking_id, created_at, archived_at)
thread_participants(thread_id, user_id, role, joined_at, last_read_message_id)
```

Actual messages live in Cassandra (see 8.3).

#### `content` schema

```
pages(id, slug, kind, status, published_at)
page_versions(id, page_id, body_markdown, body_html, effective_at, author_id, change_summary)
articles(id, slug, kind, category_id, author_id, status, published_at, hero_image_key, seo_meta_json)
article_versions(id, article_id, ...)
help_categories(id, name, parent_id, sort_order)
```

#### `ads` schema

```
ad_campaigns(id, name, advertiser_kind, advertiser_id, status, budget, start_at, end_at)
ad_creatives(id, campaign_id, asset_keys[], headline, body, cta_url, status)
ad_placements(id, slot_code, supported_creative_kinds[])
ad_targeting_rules(id, campaign_id, kind, value)
ad_impressions(id, creative_id, user_id, slot_code, occurred_at)  -- mirrored to Cassandra for scale
ad_clicks(id, creative_id, user_id, slot_code, occurred_at)
```

#### `audit` schema (PostgreSQL hot index, Cassandra cold)

```
audit_events(id, actor_user_id, actor_role, action, resource_kind, resource_id, before_json, after_json, ip, user_agent, occurred_at)
```

### 8.3 Cassandra Keyspaces

| Keyspace.Table                 | Partition Key                          | Clustering Keys                                  | Purpose                                         |
| ------------------------------ | -------------------------------------- | ------------------------------------------------ | ----------------------------------------------- |
| `messaging.messages_by_thread` | `thread_id`                            | `bucket DESC, message_id DESC`                   | Chronological message scroll, bucketed by month |
| `messaging.message_inbox`      | `user_id`                              | `bucket DESC, occurred_at DESC, message_id DESC` | Recent unread aggregation                       |
| `activity.events_by_user`      | `(user_id, bucket)`                    | `occurred_at DESC, event_id`                     | User activity timeline                          |
| `audit.events_by_resource`     | `(resource_kind, resource_id, bucket)` | `occurred_at DESC, event_id`                     | Resource audit replay                           |
| `audit.events_by_actor`        | `(actor_user_id, bucket)`              | `occurred_at DESC, event_id`                     | Per-admin audit search                          |
| `notification.history`         | `(user_id, bucket)`                    | `occurred_at DESC, notification_id`              | Delivery log + replay                           |
| `ads.impressions`              | `(creative_id, bucket_hour)`           | `occurred_at DESC, impression_id`                | High-write-volume impressions                   |
| `analytics.events`             | `(event_name, bucket_day)`             | `occurred_at DESC, event_id`                     | Product analytics raw stream                    |

`bucket` is typically `YYYYMM` or `YYYYMMDD` to bound partition size.

### 8.4 Redis Usage

- **Cache:** provider profile cards, plan catalog, search facets — TTL 5–60s with background refresh
- **Sessions:** rotating refresh-token reuse detection
- **Rate limiting:** sliding window per user/IP/endpoint
- **BullMQ:** job queues for billing, notifications, search indexing, analytics aggregation, payout reconciliation
- **Pub/Sub:** Socket.IO message fan-out across pods
- **Distributed locks:** Redlock for cross-service mutex (e.g., monthly accounting period close)

### 8.5 Search Indices (Elasticsearch)

- `providers` — denormalized provider doc (name, bio, specialties, languages, certifications, geo, ratings, tier, availability summary)
- `articles` — blog and help center
- `seniors_admin` — admin-only senior search (PII-aware, masked at field level)
- `bookings_admin` — admin-only operational search
- All indices populated by an indexer worker subscribing to domain events

---

## 9. Domain Workflows (Selected Sequences)

### 9.1 Family Subscription Sign-Up

```
User → web-family → gateway-api → identity-svc.create_account
                                → subscription-svc.create_subscription
                                  ↳ Stripe.create_customer
                                  ↳ Stripe.create_subscription
                                  ↳ accounting-svc emits journal:
                                    DR Cash / CR Deferred Revenue
                                → notification-svc.queue welcome email
                                → audit-svc records action
```

### 9.2 Booking Lifecycle

```
Family books visit
  → booking-svc.create_booking (status=pending)
  → provider receives push + email; accepts
  → status=confirmed
  → on visit day:
       provider check-in → status=in_progress
       provider submits notes + check-out → status=completed
  → booking.completed event:
       accounting-svc:
         DR Customer Receivable / CR Marketplace Revenue (gross)
         DR Marketplace Revenue Contra / CR Provider Payable (provider portion)
       payouts-svc schedules disbursement
       notification-svc emails wellness summary to family
       analytics-svc updates booking funnel metrics
```

### 9.3 Coupon Redemption

```
User enters code at checkout
  → subscription-svc.validate_coupon
       checks: active, not expired, eligible plan, customer-eligible, max redemptions
  → on subscription.create:
       Stripe.coupon applied at checkout
       coupon_redemptions row inserted
       accounting-svc emits contra-revenue entry on first invoice
  → analytics-svc updates campaign attribution
```

### 9.4 Provider Payout

```
Daily payouts-worker runs:
  → reads provider_payable_balances above threshold
  → invokes Stripe.transfer to connected account
  → on Stripe webhook:
       accounting-svc emits:
         DR Provider Payable / CR Cash
       notification-svc emails payout summary
       1099 accumulator updates
```

### 9.5 Welfare Concern Escalation

```
Provider flags welfare during visit
  → trust-safety-svc.create_incident (severity=high)
  → audit-svc records
  → notification-svc pages on-call concierge supervisor (PagerDuty)
  → admin queue surfaces with SLA timer
  → resolution recorded with mandatory reviewer signoff
```

---

## 10. Authentication & Authorization

### 10.1 Authentication

- Primary: email + password with bcrypt (work factor 12+)
- Secondary: magic link, SMS OTP, social (Apple, Google) — optional
- MFA: TOTP required for staff, optional for users; SMS OTP fallback
- Session tokens: short-lived JWT (15m) + rotating refresh token (30d) with **reuse detection** invalidating all sessions on suspected theft
- Cookies: HttpOnly, Secure, SameSite=Lax for web apps

### 10.2 Authorization (RBAC + ABAC)

- **Roles** (system-defined): `family_payer`, `family_observer`, `senior_user`, `provider`, `partner_admin`, `partner_member`, `student`, plus admin roles below
- **Admin roles**: `super_admin`, `operations_manager`, `customer_support`, `concierge_lead`, `provider_ops`, `finance`, `marketing`, `content_editor`, `trust_safety`, `read_only_auditor`
- **Permissions** are namespaced strings: `subscription:write`, `provider:approve`, `accounting:close_period`, `audit:read`, etc.
- **Scopes** — roles attach to a scope (`global`, `tenant:{partnerId}`, `household:{householdId}`)
- **ABAC** layer enforces row-level checks (e.g., a partner_admin can only see residents within their partner_id; a provider can only see bookings where provider_id == their id)
- All check decisions are logged for audit

### 10.3 RBAC Admin Tooling

The admin panel provides:

- Role builder UI (system roles read-only, custom roles editable)
- Permission picker grouped by resource
- Bulk role assignment with expiration dates
- Permission diff visualization on edits
- All changes generate audit events

---

## 11. Payments & Financial Subsystem

### 11.1 Stripe Integration

- **Stripe Billing** for subscription plans, invoicing, dunning
- **Stripe Connect** (Express) for provider onboarding and payouts
- **Stripe Tax** for sales-tax calculation where applicable
- **Stripe Identity** for provider KYC light
- **Stripe Webhooks** consumed by `webhook-svc` with signature verification, idempotency tracking, and retry-safe processing

### 11.2 Double-Entry Accounting Engine

The `accounting-svc` is the single source of truth for financial state. Key principles:

- Every financially-relevant event in the platform is mapped to a journal entry with balanced debits and credits
- Journal entries are immutable; reversals are explicit, traceable, and require role `finance:adjust`
- The chart of accounts is configured per business line and supports sub-accounts (e.g., revenue.subscriptions.tier_2)
- Period close locks journal entries; off-period adjustments require explicit reopen (audited)
- Daily reconciliation against Stripe balance and bank statements is automated; mismatches generate tickets
- SaaS metrics (MRR, ARR, ARPU, churn, retention cohorts) are computed nightly from ledger primitives
- Multi-currency-ready schema (single currency at launch)
- Exports to QuickBooks Online and CSV formats for finance team
- BIR-style tax reporting hooks (extensible to state and federal US filings)

### 11.3 Provider Payouts

- T+2 schedule with hold for completed bookings (allowing dispute window)
- Tier-dependent commission: 10% (Elite), 20% (Certified), 30% (Basic) on bookings; 15% on add-ons
- Annual 1099-NEC generation with bulk filing readiness
- Payout statements available in provider portal
- Held balances visible to admin

### 11.4 Refunds & Adjustments

- Self-serve cancellation generates pro-rated refund per policy; automated journal reversals
- Manual adjustments require role `finance:adjust` and reason code; audit-logged
- Customer credit ledger for goodwill credits (separate from refunds)

---

## 12. Notifications & Communications

### 12.1 Channels

- Transactional email (Postmark/SES) — high-priority, deliverability-critical
- Marketing email (SendGrid/Customer.io) — opt-in lists, segmentation
- SMS (Twilio) — booking reminders, OTPs, escalations
- Push (APNs + FCM) — booking notifications, messages
- In-app — real-time via WebSocket

### 12.2 Templating

- All templates managed in admin CMS with versioning, preview, and test sends
- MJML for email; Handlebars/MJML hybrid
- Locale-aware template selection
- Variables strictly typed via shared contract package

### 12.3 Preferences

- Per-channel and per-category preferences (transactional vs. marketing)
- Quiet hours per user
- Senior-mode default: no marketing pushes after 8pm
- TCPA / CAN-SPAM compliance enforced at send time

---

## 13. Real-Time Subsystem

### 13.1 Messaging

- Threads created on booking creation, household onboarding, or concierge ticket creation
- Messages persisted in Cassandra (`messages_by_thread` table)
- Real-time delivery via Socket.IO with Redis adapter for multi-pod fan-out
- Read receipts updated in PostgreSQL `thread_participants.last_read_message_id`
- Attachments uploaded to S3, referenced via signed URL
- Translation assistance via on-demand call to translation API (cached)

### 13.2 Virtual Family Meal

- Daily.co (or LiveKit) rooms scheduled at booking time
- Family members and senior household receive join links
- Recordings disabled by default; opt-in with consent
- Provider can join in-room as host

---

## 14. Search Subsystem

### 14.1 Provider Discovery

- Elasticsearch index updated by `search-indexer` worker on relevant domain events
- Geo-distance scoring with provider service-area polygons
- Tier-aware boosting (Elite > Certified > Basic) configurable
- Filters: cuisine, language, dietary, certification, tier, rating, availability window

### 14.2 Content Search

- Articles, help center, blog all indexed
- Synonym dictionary for senior-care vocabulary

### 14.3 Admin Search

- Cross-domain admin search powered by ES with role-aware document filters
- PII redaction at field level for read-only auditor roles

---

## 15. Cooking Academy Subsystem

### 15.1 Learning Architecture

- Courses → Modules → Lessons; lessons can be video, reading, quiz, or assignment
- Video assets stored in S3, served via signed CloudFront URLs with time-bounded access
- Live cohorts use Daily.co rooms with attendance tracking
- Quiz engine with question banks and randomized selection
- Progress and completion tracking per enrollment
- Certificate generation as PDF with verification URL

### 15.2 Certifications

- Certifications tied to course completion + assessment passage
- Renewal cycles (e.g., 24 months) with continuing-education requirements
- Certification status syncs to `provider-svc` to gate tier eligibility

### 15.3 Academy Membership

- Subscription product gating library access and live event registration
- Alumni networking directory (opt-in)

---

## 16. Trust, Safety & Compliance

### 16.1 Trust & Safety Workflows

- Incident report intake from family, senior, provider, and concierge
- Severity triage (low / medium / high / critical) with SLA timers
- Mandated reporter pathway for suspected elder abuse with clear documentation
- Provider review committee toolset: 360 view of provider, complaints history, certifications, performance
- Automated holds (booking suspension) on high-severity flags pending review

### 16.2 Background Checks

- Checkr integration with continuous monitoring for Tier 2/3 providers
- Status persistence with provider record
- Reverification cadence per state requirements

### 16.3 Privacy & Data Handling

- PII inventory maintained; access logged and limited
- Field-level encryption for SSN, DOB, dementia status, medical details
- Data subject access requests fulfilled via self-service export
- Data deletion workflows respect legal retention requirements (financial records, audit logs)
- Senior consent captured and stored for photos, recordings, third-party sharing
- HIPAA-aligned for healthcare partner workflows (BAA, audit, minimum necessary)

### 16.4 Compliance Posture

- SOC 2 Type II controls implemented from launch
- HIPAA-ready architecture with isolated PHI handling for healthcare partners. **Phase 1 caveat (ADR-0001):** the Phase 1 Contabo VPS deployment does **not** ship with a BAA — Contabo is ISO 27001-certified but does not sign BAAs. Healthcare partner workflows (TS-410, Phase 3) are blocked on migration of the PHI-handling slice to a BAA-eligible provider (AWS / Azure / GCP / Aptible). Phase 1 launch scope is family-pay marketplace only, no PHI surfaces.
- PCI DSS via Stripe (no card data handled in platform)
- CCPA / state privacy law compliance with Privacy Center for users
- Mandated reporter laws by state — workflow kit per state

---

## 17. Audit & Activity Logging

### 17.1 Admin Audit Log

- Every mutation by admin staff produces an audit event
- Event includes: actor, role, action, resource, before/after diff, IP, user-agent, request ID
- Stored in Cassandra (cold) with hot 90-day window in PostgreSQL for fast queries
- Tamper-evident via hash chaining (each event stores hash of previous event for the same resource)
- Searchable via admin UI by actor, action, resource, time range

### 17.2 User Activity Log

- Logins, logout, profile changes, payment changes, booking changes
- Visible to user via "Activity" page; download as CSV
- Suspicious-activity flags surface to user and trust & safety

### 17.3 Site-Wide Activity Monitoring

- Real-time event stream consumed by Trust & Safety dashboard
- Alerting rules: impossible travel, mass cancellations, rapid coupon use, abnormal API call patterns
- Integration with security incident response (PagerDuty + runbooks)

---

## 18. Ads & Promotions Subsystem

### 18.1 Inventory Model

- **Slots** — predefined positions in product UI (home banner, search top-tile, dashboard sidebar, blog footer, partner co-marketing card)
- **Campaigns** — advertiser-bound, budget-bound, with start/end dates and creative assets
- **Targeting** — audience expression (geography, persona, tier, behavior cohort, household composition); evaluated server-side
- **Frequency capping** — Redis-backed counters per user × campaign × period

### 18.2 Delivery

- Edge personalization considered for marketing surfaces; default is server-rendered with cache keys including audience hash
- Impressions and clicks captured via dedicated endpoints, batched, and persisted to Cassandra
- Daily aggregations compute CTR, CPM, CPC, conversion attribution

### 18.3 Compliance & Approval

- Creative approval workflow with role `marketing:approve_creative`
- Mandatory disclosure ("Sponsored") on relevant placements
- Accessibility checks on creative assets (alt text, contrast)

---

## 19. Content Management Subsystem

### 19.1 Blog

- WYSIWYG (TipTap) and Markdown authoring side-by-side
- Frontmatter for SEO metadata
- Image uploads with automatic resizing pipeline
- Drafts, scheduled publish, unpublish
- Categories and tags
- Author profiles with bio and photo
- Related posts ML-suggested
- Newsletter integration: per-post send capability
- Comments via embedded Disqus or self-hosted moderated comments
- Multi-author collaboration with role-based permissions (`content:edit`, `content:publish`)

### 19.2 Static Pages CMS

- Pages by slug: `privacy`, `terms`, `cookie-policy`, `accessibility`, `about`, `press`, `provider-code-of-conduct`, `partner-faq`
- Versioned content with `effective_at` so prior versions remain reachable for legal reference
- Material change detection triggers notification to active subscribers (email + in-app)
- Diff view between versions
- Multi-language placeholders (Phase 3)

### 19.3 Help Center

- Hierarchical categories
- Article search powered by Elasticsearch
- Article feedback (Was this helpful?)
- Related articles
- Embedded contact-support CTA
- Segment-specific help (Family / Provider / Partner / Academy)

---

## 20. Infrastructure & DevOps

### 20.1 Container Strategy

- Each service has a multi-stage Dockerfile (build → runtime). The runner stage copies the Node binary (version pinned via `.nvmrc` / `engines.node` — currently Node 22) onto a fresh `alpine:3.22` base, stripping upstream's `npm`/`yarn`/`corepack`. The canonical template lives at `infra/docker/nestjs.Dockerfile`; per-service Dockerfiles are forbidden except for genuinely bespoke needs.
- Directional size budget on the runner image: **compressed pull < 75 MB** (drives K8s pod-start time and registry egress), **virtual size < 250 MB** (drives node-disk pressure). Compressed pull is the operationally-meaningful number; budgets recalibrate on every Node LTS bump (the v22 → v24 binary is expected to grow this further). See `infra/docker/README.md` for current measurements and per-layer breakdown.
- Images scanned by Trivy in CI
- Signed with cosign; admission policy enforces signed-image-only in prod

### 20.2 Kubernetes Topology

**Phase 1 (ADR-0001):** self-managed **k3s** with embedded etcd HA on Contabo Cloud VPS (US-Central / St. Louis). Three nodes serve as combined control-plane + worker; one dedicated data node hosts self-hosted Postgres 16 + Redis 7. The Kubernetes object model below is unchanged from the eventual cloud target — only the control-plane operator changes.

**Phase 3 migration target:** managed Kubernetes (AKS / EKS / GKE / DOKS) when (a) healthcare partner workflows land (TS-410, requires BAA-eligible provider, see §16.4) or (b) ops volume outgrows the self-managed posture. Manifests + Helm releases + ArgoCD apps transfer 1:1.

- **Namespaces:** `platform-system`, `platform-data`, `platform-services`, `platform-workers`, `platform-frontends`, `observability`, `ingress`
- **Workload kinds:** Deployments for stateless services, StatefulSets for Cassandra/Redis where self-managed (managed services preferred where the deployment supports them), CronJobs for scheduled tasks, Jobs for one-shot migrations
- **Autoscaling:** HPA on CPU + custom metrics (queue depth for workers, request rate for services)
- **Pod Disruption Budgets** for booking-svc, gateway, identity, accounting
- **NetworkPolicies** to restrict service-to-service traffic to declared dependencies
- **PodSecurityStandards:** baseline → restricted progression
- **Resource quotas** per namespace

### 20.3 Environments

- `dev` — shared development environment (Phase 1: single k3s cluster on Contabo; ephemeral preview environments per PR follow once cluster autoscaling / namespace-per-PR is wired)
- `staging` — production parity, used for QA and stakeholder demos, anonymized data
- `prod` — production workloads. **Phase 1:** single-region (Contabo US-Central) with intra-cluster HA via 3-node etcd quorum + data-node WAL archive to off-provider object storage. **Phase 3:** multi-region / multi-AZ posture per §20.6 follows the managed-K8s migration.

### 20.4 CI/CD

- GitHub Actions pipeline per app/service:
  - Lint, type-check, unit tests
  - Integration tests against ephemeral Postgres + Redis containers
  - Contract tests against published OpenAPI/SDL
  - Security scan (Trivy, Snyk)
  - Build + push image to registry
  - Update GitOps manifests in `infra/` repo
- ArgoCD reconciles cluster from GitOps repo
- Progressive delivery via Argo Rollouts (canary or blue/green) for high-risk services

### 20.5 Observability

- **Logs:** structured JSON with correlation IDs → Loki
- **Metrics:** Prometheus scraping standard service exporters and app-level counters → Grafana dashboards
- **Traces:** OpenTelemetry → Tempo, full request tracing across service hops
- **Errors:** Sentry per app with release tagging
- **Synthetic checks:** Checkly or Grafana Synthetics for booking, payment, search, login critical flows
- **Alerting:** PagerDuty rotations for on-call
- **SLOs** defined per service with error budgets

### 20.6 Backups & DR

**Phase 1 (Contabo, ADR-0001):**

- PostgreSQL: `pgBackRest` continuous WAL archiving to Contabo Object Storage; nightly full + hourly incremental backups; point-in-time recovery within retention window (default 14 days). Restore drill documented in `infra/terraform/README.md`.
- Redis: AOF + RDB persistence to local NVMe; nightly `restic` snapshot to Contabo Object Storage.
- Cluster state (etcd): k3s automatic etcd snapshots every 12h, retained 5 generations, mirrored to Object Storage.
- Object Storage: Contabo Object Storage versioning enabled on the `backups` bucket; cross-region copy is **not** available on Contabo — `pgBackRest` ships a second copy to an off-provider bucket (e.g., Backblaze B2) for the prod env.
- RTO < 1 hour, RPO < 15 min on Postgres (WAL archive interval 60s). DR drills quarterly with documented runbooks.

**Phase 3 (managed cloud, post-§20.2 migration):**

- Provider-native managed-DB PITR + cross-region replication
- Cassandra: snapshots + incremental backups via Medusa
- Object storage: versioning + cross-region replication
- RTO / RPO unchanged.

### 20.7 Secrets Management

- Vault or cloud-native secrets manager
- Workload identity (IRSA / Workload Identity Federation) — no static keys
- Rotation policies: 90 days for application secrets, 180 days for service accounts
- Sealed-secrets for any committed values

---

## 21. Security Architecture

### 21.1 Network Security

- WAF at edge (AWS WAF / Cloudflare)
- DDoS protection at edge
- VPC-isolated cluster; private subnets for services and data
- mTLS between services (service mesh) for Phase 2+
- Private endpoints for managed databases

### 21.2 Application Security

- OWASP ASVS checklist enforced
- Input validation at gateway and service boundaries
- Output encoding for all user-rendered content
- CSP, HSTS, XFO, CSRF tokens, COOP/COEP for web apps
- Dependency scanning + SBOM generation
- Static analysis (Semgrep) in CI
- DAST in staging
- Annual penetration testing
- Bug bounty program (post-stabilization)

### 21.3 Data Security

- Encryption at rest with KMS-managed keys (per service envelope encryption)
- Encryption in transit (TLS 1.3 minimum)
- Field-level encryption for sensitive PII (DOB, SSN, dementia status, medical notes)
- Tokenization of payment instruments via Stripe
- Backup encryption
- Key rotation on schedule

### 21.4 Application-Layer Hardening Patterns

- JWT with rotating refresh tokens and **reuse detection**
- Idempotency keys on all write endpoints
- Prisma tenant-scoping middleware enforcing row-level access
- Append-only audit logs with hash chaining
- Redis key namespacing to prevent cross-tenant leakage
- Sharp `limitInputPixels` on image processing
- Magic-byte MIME validation on all uploads
- Prompt-injection defense on any LLM-touching endpoints (Phase 2 AI features)
- Rate limiting on auth and high-cost endpoints

### 21.5 Image & File Upload Pipeline

1. Client requests signed URL from `media-svc`
2. Client uploads directly to S3 (size-limited)
3. S3 event triggers media processor
4. Magic-byte validation
5. Decompression bomb protection (`limitInputPixels`)
6. ClamAV virus scan
7. Sharp resize + format conversion
8. CDN cache pre-warm
9. Metadata stored in PostgreSQL with virus-scan status

---

## 22. Mobile Strategy

### 22.1 Phase 1 (Months 0–6)

- Responsive PWA via Next.js for all client apps
- Add-to-home-screen on iOS / Android
- Push notifications via web push (limited)

### 22.2 Phase 2 (Months 6–18)

- React Native / Expo apps for Family and Provider
- Shared business logic via packages in monorepo
- EAS Build pipeline integrated with CI
- Biometric auth on supported devices

### 22.3 Phase 3

- Senior-mode native variant with simplified UX
- Offline support for visit notes (provider)
- Apple Watch / Wear OS companion (provider check-ins)

---

## 23. Analytics & Reporting

### 23.1 Product Analytics

- Event taxonomy with 60+ event types covering signup, subscription lifecycle, booking funnel, provider engagement, academy progress, partner utilization
- Events captured server-side (preferred) and client-side via analytics SDK
- Streamed to Cassandra for raw retention; aggregated nightly to PostgreSQL marts
- Mart tables expose to admin dashboards and BI tools (Metabase / Looker)

### 23.2 SaaS Metrics

- MRR, ARR, ARPU, LTV, CAC, gross margin, NRR, GRR
- Computed from ledger primitives by `analytics-svc` nightly
- Cohort retention by signup month, channel, plan
- Self-serve in admin dashboard with drill-down

### 23.3 Operational Reports

- Daily ops dashboard: bookings today, completed, canceled, escalations, payout queue, pending payments
- Weekly partner reports auto-emailed to partner admins
- Monthly board pack auto-assembled

---

## 24. Testing Strategy

### 24.1 Test Pyramid

- **Unit tests** in every service and frontend package (Jest, Vitest)
- **Integration tests** for service-DB, service-Redis, service-message-bus interactions
- **Contract tests** between services (Pact or schema-based)
- **E2E tests** with Playwright covering critical flows: signup, subscription, booking, payment, message
- **Performance tests** with k6 against staging
- **Security tests** with OWASP ZAP and Burp in CI gates

### 24.2 Quality Gates

- 80% coverage floor on services with financial implications (subscription, accounting, payouts, booking)
- All PRs require passing CI, code review, and contract validation
- Schema migrations require migration-review label

### 24.3 Test Environments

- Each PR spins up an ephemeral preview env with seeded data
- Staging mirrors production topology
- Anonymized production data refresh into staging weekly

---

## 25. Migration & Seeding

### 25.1 Database Migrations

- Prisma migrate per service with explicit migration SQL committed
- Forward-compatible deploys (expand → migrate → contract pattern)
- Cassandra schema managed via Cassandra Migrator with idempotent CQL

### 25.2 Seed Data

- Plan catalog seeded per environment
- Service catalog seeded with default service kinds
- Chart of accounts seeded with standard SaaS chart
- System roles and permissions seeded
- Sample tenants for staging and dev

---

## 26. Documentation & Engineering Standards

### 26.1 ADR (Architecture Decision Records)

- All non-trivial decisions captured in `docs/adrs/` using the lightweight ADR template
- Linked from PRs that implement them

### 26.2 API Documentation

- OpenAPI specs generated from NestJS via `@nestjs/swagger`
- Aggregated and published to internal docs portal
- Public-facing partner API documented separately

### 26.3 Code Standards

- Strict TypeScript, no `any` without rationale
- ESLint + Prettier enforced via Husky pre-commit
- Conventional commits + commitlint
- Branch naming: `type/scope/short-desc`
- PR template with checklist

### 26.4 Naming Conventions

- Services: `service-{domain}`
- Packages: kebab-case
- Database tables: snake_case
- API endpoints: kebab-case in URLs, camelCase in DTOs
- Event names: dot-notation, past tense (`subscription.activated`)

---

## 27. Capacity Planning (Year-1 Baseline)

| Resource                 | Baseline                            | Notes                              |
| ------------------------ | ----------------------------------- | ---------------------------------- |
| Active senior households | 1,500                               | targeting Year 1 PRD goal          |
| Active providers         | 200                                 |                                    |
| Daily bookings           | 200                                 |                                    |
| Monthly messages         | 250K                                |                                    |
| Monthly notifications    | 1M                                  | email + push + SMS                 |
| PostgreSQL primary       | 4 vCPU / 16GB / 100GB SSD           | per service avg, scales with usage |
| Cassandra cluster        | 3 nodes × 8 vCPU / 32GB / 500GB SSD | RF=3                               |
| Redis                    | 2 nodes × 4 vCPU / 16GB             | HA pair                            |
| Elasticsearch            | 3 nodes × 4 vCPU / 16GB / 200GB     |                                    |
| Kubernetes nodes         | 6 nodes × 8 vCPU / 32GB             | autoscaled to 20 at peak           |

Year 2 projections quadruple this baseline; sharding strategies for PostgreSQL (per-service split) and Cassandra (linear add-node) handle expansion without re-architecture.

---

## 28. Phased Implementation Plan (Engineering Cadence)

### Phase 1 (Months 0–6) — Concierge Lean MVP

1. **Foundations** — monorepo, IaC, K8s cluster, CI/CD, observability skeleton
2. **Identity, Household, Subscription, Stripe billing**
3. **Provider profiles (manual onboarding)**
4. **Booking lifecycle (manual matching by ops)**
5. **Messaging (basic)**
6. **Admin panel: users, subscriptions, bookings, simple accounting**
7. **Marketing site + Family portal MVP**

### Phase 2 (Months 6–18) — Marketplace & Academy

1. **Self-serve provider onboarding + tiers**
2. **Search and discovery**
3. **Tier 3 Concierge product, concierge ops console**
4. **Family peace-of-mind dashboard, wellness notes, virtual family meal**
5. **Cooking Academy: courses, certifications, cohorts**
6. **Full accounting depth: SaaS metrics, period close, payouts automation**
7. **Ads, blog, CMS, audit log, RBAC depth**
8. **Mobile (React Native) for Family + Provider**

### Phase 3 (Months 18–36) — Enterprise & National

1. **Partner portal + healthcare integrations**
2. **Multi-region rollout**
3. **Multilingual**
4. **AI matchmaking, recommendation engine**
5. **Wearable / home device integrations**
6. **White-label offering**

---

## 29. Open Technical Questions

1. **Event bus:** Redis Streams (Phase 1 simplicity) vs Kafka (Phase 3 scale and replay) — explicit migration path needed.
2. **Service mesh:** Istio's complexity vs Linkerd's simplicity; mTLS-everywhere is desired but cost/complexity must be justified.
3. **Cassandra managed vs self-managed:** AWS Keyspaces / DataStax Astra vs self-managed on K8s.
4. **GraphQL gateway vs REST aggregation:** GraphQL offers client efficiency but adds operational complexity; tilt to REST for Phase 1, GraphQL evaluation in Phase 2.
5. **Senior video-call platform:** Daily.co vs LiveKit vs Twilio Video — evaluate against accessibility and senior-mode requirements.
6. **AI/LLM integration roadmap:** matchmaking, dietary suggestion, wellness summary generation — must define data privacy and prompt-injection defenses upfront.
7. **HIPAA scope expansion** if healthcare partnerships go deep — may require dedicated PHI-isolated services.
8. **Worker classification** legal opinion (W-2 vs 1099 by state) materially affects payouts-svc and accounting-svc complexity.

---

## 30. Appendices

### Appendix A — Sample Journal Entries

| Event                                    | Debit                                | Credit                             |
| ---------------------------------------- | ------------------------------------ | ---------------------------------- |
| Tier 2 subscription charged ($299)       | Cash $299                            | Deferred Revenue $299              |
| Month elapses on $299 sub                | Deferred Revenue $299                | Subscription Revenue — Tier 2 $299 |
| Booking completed ($150, 20% commission) | Cash $150                            | Marketplace Revenue (gross) $150   |
| Same booking, provider portion           | Marketplace Revenue (contra) $120    | Provider Payable $120              |
| Provider payout disbursed                | Provider Payable $120                | Cash $120                          |
| Coupon $50 applied to invoice            | Coupon Discount (contra-revenue) $50 | Subscription Revenue $50           |
| Refund issued $99                        | Subscription Revenue $99             | Cash $99                           |

### Appendix B — Sample Permission Matrix (excerpt)

| Permission                | super_admin | ops_mgr | support | concierge_lead | provider_ops | finance | marketing | content | trust_safety | auditor |
| ------------------------- | ----------- | ------- | ------- | -------------- | ------------ | ------- | --------- | ------- | ------------ | ------- |
| `user:read`               | ✓           | ✓       | ✓       | ✓              | ✓            | ✓       | ✓         | –       | ✓            | ✓       |
| `user:suspend`            | ✓           | ✓       | –       | –              | –            | –       | –         | –       | ✓            | –       |
| `subscription:write`      | ✓           | ✓       | –       | –              | –            | ✓       | –         | –       | –            | –       |
| `accounting:close_period` | ✓           | –       | –       | –              | –            | ✓       | –         | –       | –            | –       |
| `provider:approve`        | ✓           | –       | –       | –              | ✓            | –       | –         | –       | –            | –       |
| `coupon:create`           | ✓           | –       | –       | –              | –            | –       | ✓         | –       | –            | –       |
| `content:publish`         | ✓           | –       | –       | –              | –            | –       | –         | ✓       | –            | –       |
| `audit:read`              | ✓           | ✓       | –       | –              | –            | ✓       | –         | –       | ✓            | ✓       |

### Appendix C — Out-of-Scope (Phase 1)

- Telehealth integration
- Wearable / home device data ingestion
- Direct insurance claims processing
- Public marketplace API for third-party developers
- White-label offering
- Multi-currency
- Multi-language (beyond en-US)

---

_End of PDD._
