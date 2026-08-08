# ADR-0001 — Phase 1 production deployment on Contabo VPS with self-managed k3s

- **Status:** Accepted
- **Date:** 2026-05-18
- **Deciders:** Product / Engineering (owner: brickagcopra)
- **Supersedes:** —
- **Superseded by:** —
- **Implements:** TS-150

---

## Context

PDD §20.2 originally scoped Phase 1 around managed Kubernetes (AKS / EKS / GKE) plus
managed Postgres + Redis, on the assumption that the SOC 2 + HIPAA + PCI compliance
posture (PDD §16.4, PRD §11.3) would justify the managed-service premium. The
launch market is small (Upper East Side, ~1,500 households by end of Year 1) and
the platform is bootstrapped; the engineering team is small enough that
operational simplicity matters but not so small that it can't operate a
self-managed cluster.

This ADR records the actual Phase 1 choice and the tradeoffs it accepts.

## Decision

**Phase 1 production runs on Contabo Cloud VPS in US-Central (St. Louis), with
self-managed k3s for orchestration and self-hosted Postgres 16 + Redis 7 on a
dedicated data node.** Specifically:

| Layer               | Choice                                                                                                                                                                             |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cloud / VPS         | **Contabo Cloud VPS** (`region: us-central` / St. Louis, MO)                                                                                                                       |
| Compute (cluster)   | 3× Contabo Cloud VPS L (8 vCPU / 30 GB / 800 GB NVMe), combined control-plane + worker, **k3s with embedded etcd HA**                                                              |
| Compute (data)      | 1× Contabo Cloud VPS L, dedicated to Postgres 16 + Redis 7 + pgBackRest                                                                                                            |
| Object storage      | Contabo Object Storage (S3-compatible API; endpoint region matched to VPS region)                                                                                                  |
| Ingress + TLS       | NGINX Ingress Controller in-cluster + cert-manager + Let's Encrypt                                                                                                                 |
| DNS + edge          | Cloudflare (free tier) — WAF, DDoS, CDN, DNS                                                                                                                                       |
| Cluster networking  | k3s default (flannel) over Contabo private VLAN; Tailscale mesh for operator SSH                                                                                                   |
| Terraform state     | Terraform Cloud (free tier) — remote state + locking + run history                                                                                                                 |
| Backups             | `pgBackRest` (Postgres WAL + full/incremental) + `restic` (Redis AOF) + k3s etcd snapshots, all to Object Storage; off-provider mirror to a separate S3-compatible bucket for prod |
| Observability stack | Prometheus + Grafana + Loki + Tempo as in-cluster Helm releases                                                                                                                    |

**Phase 1 scope explicitly excludes Cassandra and Elasticsearch as managed
services** — both are deferred to in-cluster StatefulSets when messaging /
audit / search volume warrants them (PDD §27 baseline does not require them at
1,500 households).

## Alternatives considered

### A. DigitalOcean (recommended first; rejected on cost)

- **Why considered:** NYC1/NYC3 data centers (matches the UES launch market),
  managed Postgres + Redis + Spaces, HIPAA-eligible with BAA, Terraform
  provider parity.
- **Why rejected:** ~5× the Phase 1 monthly cost (~$130–$180/mo vs ~€80–€100/mo
  on Contabo). User explicitly chose VPS for cost.
- **Re-entry condition:** if Phase 3 healthcare-partner workflows land
  (TS-410) and the BAA gap forces a migration of PHI-handling services.

### B. AWS / Azure / GCP managed Kubernetes (rejected on cost + complexity)

- **Why considered:** PDD §20.2 originally specified these.
- **Why rejected:** comparable cost concern to DO, plus higher operational
  complexity (cloud-specific IAM, networking, secrets, billing).
- **Re-entry condition:** same as DO — PHI handling or scale beyond what
  self-managed k3s can sustain.

### C. Hetzner Cloud (rejected on geography + managed-DB absence)

- **Why considered:** cheapest provider, excellent CPU/memory per €, decent
  Terraform provider.
- **Why rejected:** primary data centers in EU (US presence is newer / smaller
  — Ashburn VA and Hillsboro OR, not NYC). No managed Postgres or Redis. EU
  data-residency adds incidental compliance overhead for US-only launch.

### D. Docker Compose / Swarm on VPS (rejected on architectural regression)

- **Why considered:** simpler than k3s.
- **Why rejected:** invalidates PDD §20.2 / §20.4 Kubernetes assumptions,
  every per-service "K8s pre-sync Job" follow-up, TS-151 (K8s base
  manifests), TS-152 (ArgoCD bootstrap), and dozens of scaling / autoscale /
  network-policy decisions baked into the service code. The migration cost
  to recover the K8s posture later exceeds the simplicity gain now.

### E. Plain systemd + Docker on VPS (rejected for the same reason as D)

## Consequences

### Accepted (explicit)

1. **No BAA from Contabo.** PRD §11.3 + PDD §16.4 require BAA-ready
   architecture for healthcare partner workflows. Contabo does not sign
   BAAs. Phase 1 launch is family-pay marketplace only (no PHI surfaces);
   when healthcare-partner workflows land in Phase 3 (TS-410), the
   PHI-handling slice of services migrates to a BAA-eligible provider. This
   is captured as a Phase 3 prerequisite in PDD §16.4 and §20.2.

2. **Self-managed DB ops.** Backups, patching, version upgrades, and
   failover for Postgres + Redis are the platform team's responsibility.
   Mitigation: `pgBackRest` for continuous WAL archive, documented restore
   runbook, quarterly DR drills, and on-call rotation. RPO < 15 min and
   RTO < 1 hr from PDD §20.6 remain achievable.

3. **Single-region.** Contabo's US presence is St. Louis + Seattle; there
   is no multi-region replication primitive. Off-provider object-storage
   mirror (Backblaze B2 or equivalent) for prod backups + a documented
   "rebuild in another region" runbook is the Phase 1 DR posture.

4. **No managed load balancer.** NGINX Ingress runs in-cluster with
   `hostPort: 443` pinned to one or two edge nodes, fronted by Cloudflare.
   Failover of the edge-pinned node requires a DNS update or a small
   keepalived setup (deferred to a TS-150-followup if uptime warrants it).

### Preserved (no regression)

- **PDD §20.2 K8s object model** — manifests, Helm releases, ArgoCD apps
  all run unchanged on k3s.
- **PDD §20.5 observability stack** — Prometheus / Grafana / Loki / Tempo
  install in-cluster via Helm.
- **PDD §3 tech stack** — every service-level technology choice (Next.js,
  NestJS, Prisma, Postgres, Redis, BullMQ, Stripe, S3) is decoupled from
  the cloud target.

## Phase 3 migration trigger

Migrate to managed Kubernetes + managed Postgres + BAA-eligible provider
when **any** of the following becomes true:

1. **TS-410 healthcare-partner workflows enter implementation** (BAA
   requirement is binary; no path forward on Contabo).
2. **Cluster CPU steady-state exceeds 60%** for two consecutive weeks
   (sizing exhausted on the 3-node Cloud VPS L pool).
3. **Postgres write IOPS sustained above 60%** of the data node's NVMe
   ceiling.
4. **Operator burden** (DB upgrades, snapshot restores, k3s upgrades)
   exceeds 8 person-hours per month consistently.

The migration target is one of AWS EKS + RDS, Azure AKS + Azure DB for
PostgreSQL, GCP GKE + Cloud SQL, or DigitalOcean DOKS + Managed Postgres.
Choice is deferred until the trigger fires; the K8s + Terraform module
layout (TS-150) keeps the resource shapes provider-agnostic where
practical.

## References

- PRD §11.3 (Security, HIPAA-aligned)
- PDD §3 (Tech Stack), §16.4 (Compliance Posture), §20.2 (Kubernetes
  Topology), §20.3 (Environments), §20.6 (Backups & DR), §27 (Capacity
  Planning)
- CLAUDE.md §16 (Conflict between PRD and PDD must be flagged, not
  silently picked — this ADR is the flag)
- `infra/terraform/` (TS-150)
