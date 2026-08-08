# Taste & See — Kubernetes manifests (TS-151)

> Cluster-wide base + reusable Kustomize components + per-environment
> overlays for the Phase 1 k3s cluster bootstrapped by TS-150. ArgoCD
> wiring (auto-sync, app-of-apps) lands in **TS-152**; until then,
> apply manually via `kubectl apply -k overlays/<env>`.

**Companion documents:** `docs/adrs/0001-vps-contabo-k3s.md`,
`infra/terraform/README.md`, `PDD.md` §20.2 / §20.3 / §20.5 / §27.

---

## Layout

```
infra/kubernetes/
├── base/                            # cluster-wide, namespace-agnostic
│   ├── namespaces/                  # 7 namespaces + PSS labels
│   ├── priority-classes/            # 3 workload tiers
│   ├── quotas/                      # ResourceQuotas + LimitRanges
│   ├── network-policies/            # default-deny + DNS-allow
│   ├── data-access/                 # ExternalName Services + VLAN egress
│   ├── ingress-nginx/               # NGINX Ingress (Helm-inflated)
│   ├── cert-manager/                # cert-manager + LE ClusterIssuers
│   ├── observability/               # Prometheus + Grafana + Loki + Tempo (Helm-inflated)
│   └── kustomization.yaml
├── components/                      # reusable Kustomize Components
│   ├── nestjs-service/              # Deployment + Service + SA + CM + NP + PDB + HPA
│   ├── web-app/                     # same shape + Ingress
│   └── bullmq-worker/               # Deployment + SA + CM + NP + PDB
├── services/                        # per-service bases
│   └── service-identity/            # canonical example consuming the component
└── overlays/                        # per-environment composition
    ├── dev/
    ├── staging/
    └── prod/
```

---

## Quick reference

| Action                                             | Command                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Render the dev overlay locally                     | `kubectl kustomize --enable-helm overlays/dev`                                 |
| Apply dev overlay                                  | `kubectl apply -k overlays/dev --enable-helm`                                  |
| Apply staging overlay                              | `kubectl apply -k overlays/staging --enable-helm`                              |
| Apply prod overlay                                 | `kubectl apply -k overlays/prod --enable-helm`                                 |
| Validate against a real cluster's schema (dry-run) | `kubectl apply -k overlays/dev --enable-helm --dry-run=server`                 |
| Lint with kubeconform                              | `kubectl kustomize --enable-helm overlays/dev \| kubeconform -strict -summary` |

> `--enable-helm` is mandatory because `base/ingress-nginx/` and
> `base/cert-manager/` use Kustomize's HelmChartInflationGenerator. Without
> the flag, `kustomize build` silently emits the manifests without their
> Helm-rendered children, and the cluster ends up with no ingress controller.

---

## First-time bootstrap

Run these steps once per environment (dev / staging / prod) after the
TS-150 Terraform apply has produced a running k3s cluster + kubeconfig.

### 1. Label the edge nodes

NGINX Ingress runs as a DaemonSet pinned to nodes carrying the
`taste-and-see.io/role-ingress=true` label + taint. Pick one or two
cluster nodes to act as the ingress edge:

```sh
# Label exactly the nodes you want to receive 443/80 traffic.
kubectl label node <node-1> taste-and-see.io/role-ingress=true
kubectl taint node <node-1> taste-and-see.io/role-ingress=true:NoSchedule
```

Cloudflare A records (managed by the TS-150 Terraform `dns` module)
already resolve to these nodes' public IPs — the label/taint pair is
what tells the NGINX DaemonSet to actually schedule there.

### 2. Patch the data-node CIDR (only if not the default `10.40.0.0/24`)

If your environment's VLAN CIDR diverges from the default the
`base/data-access/egress-network-policies.yaml` manifest carries,
add a strategic-merge patch in your overlay rather than editing
the base. The CIDR also governs the `ip -4 addr show` detection
in TS-150's k3s cloud-init — keep them in sync.

### 3. Seal the per-service Secrets (TS-151-followup-2)

> This step used to be ~30 hand-typed `kubectl create secret generic`
> commands across ~133 keys, each followed by manually deleting that
> service's `secret-placeholder.yaml` from the overlay — and forgetting
> the deletion meant the next apply overwrote a live credential with
> `REPLACE_WITH_…`, after which the pod failed Zod validation at boot.
> `infra/kubernetes/scripts/seal-secrets.mjs` replaces the whole step.

The sealed-secrets controller ships in `base/sealed-secrets/`, so it is
already installed by the time you reach this step. Its private key is
generated in-cluster on first start and never leaves — **which is what
makes committing the ciphertext safe, and what makes losing the key
unrecoverable.** Back it up before you do anything else (§ Secrets below).

```sh
# 1. Produce a blank values file covering every workload and key.
node infra/kubernetes/scripts/seal-secrets.mjs --template > secrets.dev.env

# 2. Fill it in. It is gitignored; it holds live credentials in plaintext.
#    Everything after the first `=` is the literal value — no trailing comments.

# 3. Validate offline. Catches missing, empty, still-templated, stray-whitespace
#    and misspelled entries before anything touches the cluster.
node infra/kubernetes/scripts/seal-secrets.mjs --check --values secrets.dev.env

# 4. Fetch this cluster's public key and seal.
kubeseal --fetch-cert \
  --controller-namespace platform-system \
  --controller-name sealed-secrets-controller > /tmp/pub-cert.pem

node infra/kubernetes/scripts/seal-secrets.mjs --seal --env dev \
  --values secrets.dev.env --cert /tmp/pub-cert.pem

# 5. Destroy the plaintext copy. The durable copy lives in a password manager.
shred -u secrets.dev.env   # or your platform's equivalent
```

Step 4 writes `overlays/dev/sealed-secrets/` (one SealedSecret per
workload plus a generated Kustomize **Component**) and adds
`components: [./sealed-secrets]` to the overlay. The component's
`$patch: delete` directives retire every `secret-placeholder.yaml`, so
the placeholder can no longer overwrite the real credential. Commit the
generated directory — the ciphertext is the artefact that belongs in git.

Two properties worth knowing before you run it:

- **Ciphertext is bound to `(namespace, name)`.** The script reads each
  workload's namespace from its own kustomization rather than assuming
  `platform-services` — 9 of the 30 live in `platform-workers`, and
  sealing those against the wrong namespace produces manifests the
  controller silently refuses to decrypt at sync time.
- **The key inventory is derived from the placeholders**, so it cannot
  drift: add a key to a `secret-placeholder.yaml` and the script starts
  demanding a value for it.

Use `--stub` in place of `--seal` to generate structurally valid but
**unencrypted** manifests — useful for render-testing the wiring with no
cluster in reach. Never apply or commit stub output.

The observability stack's Grafana admin login is likewise an
out-of-band Secret (no password committed, per CLAUDE.md §17.12).
It is deliberately NOT part of the sealed set above: the chart reads it
via `grafana.admin.existingSecret`, and it is one credential rather than
a per-service contract, so it stays a single documented command:

```sh
kubectl create namespace observability --dry-run=client -o yaml | kubectl apply -f -

kubectl -n observability create secret generic grafana-admin \
  --from-literal=admin-user='admin' \
  --from-literal=admin-password='<32+ char password>'
```

The `kube-prometheus-stack` chart reads this via
`grafana.admin.existingSecret`; without it the Grafana pod will not start.

### 4. Apply the overlay

```sh
kubectl apply -k overlays/dev --enable-helm
```

Order of apply (Kubernetes resolves the dependency graph itself but
the wave shape ArgoCD emits in TS-152 mirrors this):

1. Namespaces + PriorityClasses (no dependencies)
2. ResourceQuotas + LimitRanges (need the namespaces)
3. NetworkPolicies + Secrets + ConfigMaps (need the namespaces)
4. cert-manager + NGINX Ingress controller (need namespaces + their
   own CRDs; the chart-inflated manifests carry CRDs ahead of the
   Deployments)
5. ExternalName Services + ClusterIssuers
6. Per-service Deployments + Services + Ingresses + HPAs

> **Database migrations are step 5.5, and only ArgoCD runs them.**
> Each of the 20 schema-owning services ships a `migrate-job.yaml`
> (TS-151-followup-12) annotated as an ArgoCD `PreSync` hook at
> `sync-wave: -10`. It runs `prisma migrate deploy` from a dedicated
> `<service>-migrator` image, ahead of both the pods and the wave-0 seed
> Jobs, and a failure aborts the sync rather than rolling code onto a
> schema that did not land.
>
> A plain `kubectl apply -k` does **not** honour hook annotations — it
> applies the Jobs as ordinary resources, concurrently with the Deployments
> and with no ordering guarantee. Do not hand-roll the migration container
> either: the Job manifest already carries the `DATABASE_URL` `secretKeyRef`
> and the restricted-PSS security context, and a `kubectl run` equivalent
> has neither. Render the Jobs out of the overlay and apply just those first:
>
> ```sh
> kubectl kustomize --enable-helm overlays/dev \
>   | yq 'select(.kind == "Job" and (.metadata.name | test("-migrate$")))' \
>   | kubectl apply -f -
> kubectl -n platform-services wait --for=condition=complete job -l app.kubernetes.io/component=db-migrate --timeout=10m
> kubectl apply -k overlays/dev --enable-helm
> ```
>
> This is one more reason the ArgoCD path (`infra/argocd/README.md`) is the
> supported one and `kubectl apply -k` is a debugging aid.

### 5. Verify

```sh
kubectl get nodes
kubectl get pods -A
kubectl get svc -A
kubectl get ingress -A
kubectl get networkpolicy -A
kubectl get clusterissuer
kubectl describe pod -n platform-services -l app.kubernetes.io/name=service-identity
```

A healthy first apply shows:

- All 7 namespaces `Active`
- NGINX Ingress DaemonSet `READY` on the labelled node(s) only
- cert-manager 3 Deployments `READY` in `platform-system`
- `service-identity` Deployment `READY` (3 pods in prod, 2 in
  staging, 1 in dev)
- TLS certificate `READY=True` once the LE HTTP-01 challenge
  completes (~30-60s after the Ingress is created)
- `observability` namespace: Prometheus + Alertmanager StatefulSets,
  Grafana + kube-state-metrics Deployments, node-exporter DaemonSet,
  and the `loki` + `tempo` StatefulSets all `READY`; `kubectl get
ingress -n observability grafana` resolves to the env's
  `grafana.<env>.tasteseelife.com` host

---

## Adding a new service

For an existing NestJS service (e.g. `service-subscription`):

1. Create `infra/kubernetes/services/service-subscription/kustomization.yaml`
   modelled on the `service-identity/` example.
2. Replace every occurrence of `service-identity` with
   `service-subscription` + adjust the `PORT` value to the
   service-specific port from `apps/service-subscription/src/config/env.ts`.
3. Author the matching `secret-placeholder.yaml` listing each
   secret-class env var the service expects.
4. Add the per-service base path to every overlay's `resources:` list:
   `- ../../services/service-subscription`.
5. Re-render: `kubectl kustomize --enable-helm overlays/dev`.

Per-service bases for the remaining ~20 apps are captured as
**TS-151-followup-1**.

---

## Promotion (staging / prod)

The three overlays are promoted on different cadences:

- **dev** auto-bumps. Every push to `main` that rebuilds a service runs that
  service's `*-build.yml`, whose `bump-dev-overlay` job rewrites the dev
  overlay's `newTag` to the freshly-built `sha-<short-sha>` and commits back
  to `main`. ArgoCD's `platform-dev` Application then auto-syncs.
- **staging / prod** are **never** auto-bumped. Promotion is an operator-
  driven, reviewable PR per CLAUDE.md §11 + PDD §11 (soak-then-promote).

Promote with the **`Promote overlay`** workflow
(`.github/workflows/promote-overlay.yml`, **TS-009g-followup-2**):

1. Actions → **Promote overlay** → **Run workflow**. Pick the target
   `environment` (`staging` / `prod`) and the `source_sha_tag`
   (`sha-<short-sha>`) you want to roll out. (`workflow_dispatch` is gated to
   actors with write access — that is the human authorisation.)
2. The workflow resolves the tag to a real `main` commit, probes ghcr.io for
   which images actually exist at that SHA (a push only rebuilds the services
   its path filter matched, so that set _is_ "every service built at that
   SHA"), rewrites only those `newTag`s, render-validates the overlay
   (`kubectl kustomize --enable-helm`), and opens a PR with a verification
   checklist (build run, Trivy SARIF, cosign/Rekor recipe).
3. A reviewer confirms the soak + signatures and merges. The merge is a push
   to `main`, which fires the `kubernetes-validate` gate on the merge commit;
   ArgoCD then syncs the target environment (prod sync is itself manual, per
   TS-152).

> **Note:** PRs opened by the built-in `GITHUB_TOKEN` do not auto-fire their
> own checks (GitHub recursion guard), which is why the workflow render-
> validates the overlay _before_ opening the PR. Wiring a bot PAT so the PR's
> own checks run pre-merge is **TS-009g-followup-2a**.

---

## Phase 1 caveats

- **Single-region.** ADR-0001 §"Single-region". DR posture is the
  off-provider backup mirror from TS-150-followup-3 + a documented
  "rebuild in another Contabo region" runbook.
- **No managed load balancer.** Ingress pods bind `hostPort: 443/80`
  to labelled edge nodes. Failover of an edge node requires a
  Cloudflare DNS update (or a future keepalived setup —
  TS-150-followup-4).
- **PHI surfaces are out of scope.** Healthcare partner workflows
  (TS-410, Phase 3) require migration to a BAA-eligible managed
  provider — the K8s + Terraform shapes here are intentionally
  portable but the cluster itself does not carry a BAA.
- **PSS restricted on workload namespaces.** The four workload
  namespaces — `platform-services`, `platform-frontends`,
  `platform-workers`, `platform-data` — enforce
  `pod-security.kubernetes.io/enforce: restricted` (TS-151-followup-3);
  all three reusable components satisfy the bar end-to-end. The
  system / operator namespaces (`platform-system`, `observability`,
  `ingress`) stay at `baseline` because their upstream charts
  (cert-manager, NGINX Ingress, kube-prometheus-stack, Loki, Tempo,
  Grafana) are not restricted-clean upstream. `platform-data`
  enforces `restricted` but hosts no pods in Phase 1 (ExternalName
  Services + Secrets only); the future Cassandra / Elasticsearch
  StatefulSets (TS-151-followup-4 / -5) must be made restricted-clean
  or the label reverts as part of that work.
- **Sealed-secrets not yet wired.** Per-service Secrets are created
  manually via `kubectl create secret`. The repo carries
  `secret-placeholder.yaml` files only as a structural reminder of
  the env-var contract.
- **ArgoCD not yet wired.** Apply is via `kubectl apply -k`. TS-152
  introduces the GitOps app-of-apps + auto-sync + drift detection.
- **HPA without custom metrics.** Default HPAs scale on CPU only.
  Queue-depth-based scaling for BullMQ workers + RPS-based scaling
  for the gateway are captured as **TS-151-followup-N** (requires
  prometheus-adapter or KEDA).
- **Cassandra / Elasticsearch not in this slice.** These land via
  dedicated `base/` subdirectories in follow-up tasks (Cassandra
  StatefulSet in `platform-data` — TS-151-followup-4; Elasticsearch
  StatefulSet in `platform-data` — TS-151-followup-5).
- **Observability stack — single-replica, lean Phase-1 sizing.** The
  `base/observability/` Helm-inflated stack (Prometheus + Alertmanager
  - Grafana + node-exporter + kube-state-metrics via kube-prometheus-stack,
    Loki SingleBinary + filesystem store, Tempo monolithic + local store —
    **TS-151-followup-6**) ships at one replica each with on-node PVCs. The
    scalable Loki/Tempo topologies + object-storage backends + Alertmanager
    routing (Slack / PagerDuty) are follow-ups (TS-152-followup-5). Per-service
    `OTEL_EXPORTER_OTLP_ENDPOINT` wiring to Tempo and trace→log correlation
    in Grafana are also follow-ups. Prometheus scrapes existing workloads via
    the annotation-discovery job that honours the `prometheus.io/scrape`
    annotations the service/worker components already emit; the operator CRDs
    (ServiceMonitor / PodMonitor) install alongside for future adoption.

---

## CI gates

`.github/workflows/kubernetes-validate.yml` (**TS-151-followup-9**) gates
every PR touching `infra/kubernetes/**` on two jobs:

- **kubeconform** — `kubectl kustomize --enable-helm` renders each overlay
  (dev / staging / prod) and `kubeconform -strict -summary` schema-validates
  every rendered object. Unknown CRDs (resolved against the datreeio
  CRDs-catalog) are skipped, not failed, via `-ignore-missing-schemas`.
- **kube-linter** — `kube-linter lint` over the per-service bases we author
  (`services/*/`, rendered without Helm), using the curated check set in
  `.kube-linter.yaml`. The Helm-inflated upstream charts are schema-validated
  by kubeconform but not kube-lint-gated (see the config file for the
  rationale).

Still deferred (later TS-151-followup-N):

- Pinned manifest hash check (cosign-attested manifest digests)
- Apply-time `kubectl apply --dry-run=server` against the live cluster
  (TS-151-followup-10 — needs a real kubeconfig)

The operator still runs `kubectl apply --dry-run=server` against staging
before promoting to prod until TS-151-followup-10 automates it.
