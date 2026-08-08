# service-trust-safety

Trust & Safety bounded context (PRD §10.14, PDD §16). Owns the incident
queue: severity-triaged reports (welfare / safety / billing / conduct) from
families, seniors, providers, concierge, and system events, with SLA timers
driven by the severity enum.

## Status — TS-300 skeleton

| Piece                                                          | State               |
| -------------------------------------------------------------- | ------------------- |
| `trust_safety` schema: `incidents` + `outbox_events`           | ✅ (init migration) |
| `/healthz` + `/readyz`                                         | ✅                  |
| Tenant scoping (TS-141, `enforce` mode)                        | ✅                  |
| SLA computation at insert (`sla.ts` — **placeholder budgets**) | ✅                  |
| Internal `IncidentsService` create/get seam                    | ✅                  |
| Authenticated intake HTTP (`Report a concern`)                 | ⏳ TS-301           |
| `welfare.flagged` publisher + escalation consumers             | ⏳ TS-302           |
| Mandated-reporter workflow                                     | ⏳ TS-303           |
| Automated booking holds                                        | ⏳ TS-304           |
| SLA-breach sweep + paging                                      | ⏳ TS-306           |
| Build workflow / k8s manifests / gateway registry              | ⏳ deploy followups |

## Local dev

```bash
pnpm -F @taste-and-see/service-trust-safety prisma:migrate:deploy  # needs DATABASE_URL
pnpm -F @taste-and-see/service-trust-safety start:dev              # port 3026
pnpm -F @taste-and-see/service-trust-safety test
```

Skeleton env: `DATABASE_URL` (required), `PORT` (3026), `LOG_LEVEL`,
`NODE_ENV`, `SERVICE_VERSION`. No JWT/Redis clusters until TS-301 (the
no-dead-config convention).

⚠ The SLA budgets in `src/modules/incidents/sla.ts` are engineering
placeholders pending product/compliance confirmation.
