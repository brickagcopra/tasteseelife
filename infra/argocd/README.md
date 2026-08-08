# Taste & See — ArgoCD GitOps (TS-152)

> GitOps app-of-apps wiring for the Phase 1 k3s cluster bootstrapped by
> TS-150 and configured by TS-151. After the three-step bootstrap below,
> every subsequent change to `infra/kubernetes/` or `infra/argocd/` flows
> via git push → ArgoCD reconciliation; no more manual `kubectl apply`.

**Companion documents:** `infra/kubernetes/README.md`,
`infra/terraform/README.md`, `docs/adrs/0001-vps-contabo-k3s.md`,
`PDD.md` §11, §20.4.

---

## Layout

```
infra/argocd/
├── install/                            # ArgoCD itself (Helm-inflated)
│   ├── kustomization.yaml              # argo-cd chart v7.7.0 → ArgoCD v2.13.x
│   ├── values.yaml                     # HA off, kustomize.buildOptions=--enable-helm
│   └── namespace.yaml                  # argocd namespace + PSS baseline
├── projects/                           # AppProjects (per-env source / dest allow-lists)
│   ├── kustomization.yaml
│   ├── platform-dev.yaml               # wide-open auto-sync
│   ├── platform-staging.yaml           # wide-open auto-sync
│   └── platform-prod.yaml              # manual sync + business-hours window
├── root/                               # bootstrap: 3 root Applications (one per env)
│   ├── kustomization.yaml
│   ├── root-dev.yaml                   # → applications/dev/
│   ├── root-staging.yaml               # → applications/staging/
│   └── root-prod.yaml                  # → applications/prod/ (manual sync)
└── applications/                       # child Applications (the actual deploy targets)
    ├── dev/
    │   ├── kustomization.yaml
    │   └── platform.yaml               # → infra/kubernetes/overlays/dev
    ├── staging/
    │   ├── kustomization.yaml
    │   └── platform.yaml               # → infra/kubernetes/overlays/staging
    └── prod/
        ├── kustomization.yaml
        └── platform.yaml               # → infra/kubernetes/overlays/prod (manual sync)
```

The app-of-apps pattern means the bootstrap only ever touches three
directories manually: `install/`, `projects/`, `root/`. From there, ArgoCD
reconciles every other directory via git pull.

---

## Quick reference

| Action                                      | Command                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Render the install overlay                  | `kubectl kustomize --enable-helm infra/argocd/install/`                                                |
| Bootstrap step 1 — install ArgoCD           | `kubectl apply -k infra/argocd/install/ --enable-helm`                                                 |
| Bootstrap step 2 — create AppProjects       | `kubectl apply -k infra/argocd/projects/`                                                              |
| Bootstrap step 3 — create root Applications | `kubectl apply -k infra/argocd/root/`                                                                  |
| UI access (Phase 1, port-forward only)      | `kubectl port-forward svc/argocd-server -n argocd 8080:80`                                             |
| CLI login (after port-forward)              | `argocd login localhost:8080 --insecure --plaintext`                                                   |
| Get initial admin password                  | `kubectl -n argocd get secret argocd-initial-admin-secret -o jsonpath='{.data.password}' \| base64 -d` |
| List Applications                           | `argocd app list`                                                                                      |
| Manual sync of prod                         | `argocd app sync platform-prod && argocd app sync root-prod`                                           |
| Tail an Application's sync log              | `argocd app wait platform-prod --health --timeout 600`                                                 |

> `--enable-helm` is mandatory in step 1 because `install/` uses Kustomize's
> HelmChartInflationGenerator to render the upstream `argo-cd` chart. Without
> the flag, `kustomize build` silently emits the manifests without their
> chart-rendered children — the cluster ends up with no ArgoCD controller.
>
> Once ArgoCD is running, the flag is no longer needed on the operator's
> side: ArgoCD's repo-server uses `kustomize.buildOptions: --enable-helm`
> (wired in `install/values.yaml`) to keep the flag passed in-cluster.

---

## First-time bootstrap

Run these steps once per cluster after `infra/kubernetes/` is already
applied (per `infra/kubernetes/README.md`). The two README's are sequential:
TS-151 first, TS-152 second.

### Step 1 — install ArgoCD

```sh
kubectl apply -k infra/argocd/install/ --enable-helm
kubectl -n argocd rollout status deployment/argocd-server --timeout=5m
kubectl -n argocd rollout status deployment/argocd-repo-server --timeout=5m
kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=5m
```

This applies:

- The `argocd` namespace (PSS `baseline` label set; `restricted` deferred
  to TS-152-followup-3 — the upstream chart's repo-server is not yet
  restricted-PSS-clean).
- The full ArgoCD control plane: server, application-controller, repo-server,
  ApplicationSet controller, notifications controller, bundled Redis.
- Every ArgoCD CRD (Application, ApplicationSet, AppProject).
- The `argocd-cm` and `argocd-rbac-cm` ConfigMaps with the wire-up:
  - `kustomize.buildOptions: --enable-helm` (mandatory for the manifest
    inflation our kubernetes/ tree relies on)
  - `server.insecure: true` (TLS terminates at the ingress; argocd-server
    runs HTTP on :8080)
  - `application.resourceTrackingMethod: annotation` (survives label churn)
- A permissive admin RBAC policy keyed to the local `admin` user. SSO + Dex
  - per-team RBAC lands with TS-152-followup-2.

### Step 2 — create the three AppProjects

```sh
kubectl apply -k infra/argocd/projects/
```

The three AppProjects (`platform-dev`, `platform-staging`, `platform-prod`)
exist BEFORE any Application that references them. Each carries:

- A `sourceRepos` allow-list pinned to this git repo only.
- A `destinations` allow-list pinned to the seven cluster namespaces.
- A `clusterResourceWhitelist` + `namespaceResourceWhitelist` declaring
  which Kubernetes kinds the env may emit.
- For `platform-prod` only: a `syncWindows` block enforcing
  business-hours-only sync as a default-deny floor.

### Step 3 — create the three root Applications

```sh
kubectl apply -k infra/argocd/root/
```

The three root Applications (`root-dev`, `root-staging`, `root-prod`) each
point at `infra/argocd/applications/<env>/`. As soon as they reconcile, ArgoCD:

1. Creates the child Applications under `applications/<env>/`.
2. Each child syncs the matching `infra/kubernetes/overlays/<env>/` overlay.
3. Cluster state catches up to git.

`root-dev` and `root-staging` ship with `automated.prune + selfHeal: true` —
they sync immediately and stay synced. `root-prod` is manual-sync only;
the operator runs `argocd app sync root-prod` (and `argocd app sync
platform-prod` for the child) to promote.

### Step 4 — verify

```sh
# All three root Applications should land Synced + Healthy.
argocd app list

# The dev + staging child Applications should auto-sync and report Healthy.
argocd app get platform-dev
argocd app get platform-staging

# Prod child Application starts OutOfSync (manifest at HEAD, cluster un-applied)
# — that's expected. Promote when ready:
argocd app sync platform-prod
```

A healthy first apply shows:

- `argocd` namespace contains every ArgoCD deployment in `Running` state.
- `root-dev` + `root-staging` + `platform-dev` + `platform-staging`
  Applications all `Synced + Healthy`.
- `root-prod` + `platform-prod` Applications `OutOfSync` (awaiting
  operator-driven promotion).
- A `kubectl get applications -A` returns 6 manifests (3 root + 3 child).

---

## PreSync hooks: the catalog seeds

Two `batch/v1` Jobs carry `argocd.argoproj.io/hook: PreSync`, so every sync runs
them to completion **before** any Deployment rolls:

| Job                              | Source                                                              | Loads                                                  |
| -------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `service-identity-rbac-seed`     | `infra/kubernetes/services/service-identity/rbac-seed-job.yaml`     | the RBAC permission + role catalog (TS-024-followup-1) |
| `service-subscription-plan-seed` | `infra/kubernetes/services/service-subscription/plan-seed-job.yaml` | the PRD §5 plan catalog (TS-040-followup-3)            |

Both replace a line in a release runbook, and both were promoted out of it for
the same reason: the manual step was repeated on nearly every release, and its
failure mode is quiet. A missed RBAC seed rolls green and then 403s the staff
who are supposed to hold the new permission; a missed plan seed rolls green and
quotes customers the old price.

Things worth knowing before you touch them:

- **A failed hook aborts the sync, by design.** Do not "fix" a red seed by
  making it best-effort — a build serving a catalog it does not match is worse
  than a build that did not ship.
- **Both seeds are idempotent**, which is what makes a hook on _every_ sync
  defensible. They upsert and preserve row ids; neither deletes rows it does not
  own. A sync that changes no catalog changes no rows.
- **They inherit the release's image tag for free.** The overlays' `images:`
  directive is keyed on the image _name_, so a tag bump moves the Deployment and
  its seed Job together. There is no per-overlay entry to forget.
- **Delete policy is `BeforeHookCreation`, not `HookSucceeded`.** The pod log is
  the only record of what a seed did; the last run stays until the next sync
  replaces it.
- **Migrations must land first.** Both seeds write tables the Prisma migrations
  own, and CLAUDE.md §4.4 puts migrations in CI ahead of deployment. If
  migrations ever move into the cluster, give them a lower `sync-wave` than
  these Jobs.
- Debugging a stuck sync: `kubectl -n platform-services logs job/service-identity-rbac-seed`.

## Day-to-day operator workflow

### Promoting a change from staging to prod

The PDD §11 contract:

> "PR merge → image build → manifest update → ArgoCD reconciles to staging
> → soak window → promote to prod"

The git-side flow (PRs merge to `main`):

1. PR merges. CI (TS-009 family) builds + pushes the image, updates the
   per-env image tag in `infra/kubernetes/overlays/<env>/kustomization.yaml`
   for `dev` first, then `staging` after the dev soak.
2. ArgoCD's `root-dev` / `root-staging` Applications auto-sync; the
   underlying `platform-dev` / `platform-staging` children apply the new
   image tag immediately.
3. Operators monitor staging for the soak window (PDD §11 leaves the
   duration explicit — recommend 1h for non-trivial changes; 24h for
   schema migrations).
4. When ready, the operator promotes by running:
   ```sh
   argocd app sync root-prod
   argocd app sync platform-prod
   ```
   This applies the same image tag (already on `main`) to prod.

### Hotfixing a broken prod resource

Out-of-band hotfix:

```sh
kubectl -n platform-services edit deployment service-identity
# Make the urgent fix.
```

`platform-prod` does NOT have `selfHeal: true`, so the hotfix stands
indefinitely. Once the underlying issue is fixed via a PR + the prod
overlay catches up:

```sh
argocd app sync platform-prod
```

This re-applies the manifest from git and the cluster catches up.

### Emergency rollback

```sh
# Find the previous revision.
argocd app history platform-prod

# Roll back to a specific revision.
argocd app rollback platform-prod <revision>
```

ArgoCD's history is the source of truth here, not git revert; rollback is
fast (manifest-apply) without waiting on CI.

---

## Phase 1 caveats

- **No public ingress.** ArgoCD UI + gRPC are accessible only via
  `kubectl port-forward`. SSO + WAF + public hostname land with
  **TS-152-followup-2** once SSO against the company IdP is wired.
- **Single-replica controllers.** The Phase 1 cluster (3× Cloud VPS L) does
  not justify the HA overhead. Promotion to HA (3× controller / 3× server
  / Redis sentinel) is **TS-152-followup-1**, gated on cluster growth.
- **Admin user only.** A single local `admin` user holds full authority;
  per-team RBAC (operations, finance, content, etc.) ships with SSO
  (TS-152-followup-2).
- **No notifications.** The notifications controller is installed but the
  per-channel config (Slack webhook, PagerDuty integration key, email
  template set) lands with **TS-152-followup-5**.
- **No Argo Rollouts.** Progressive delivery (canary / blue-green) for
  high-risk services (booking, accounting, payouts) is **TS-152-followup-7**.
  Until then every roll is a vanilla Deployment rolling-update.
- **No ApplicationSet wiring.** Phase 1 has one canonical service base
  (service-identity); a per-service ApplicationSet is unnecessary at that
  scale. When the second service lands (likely with TS-009g + the per-service
  Kustomize bases of TS-151-followup-1), promote to an ApplicationSet —
  **TS-152-followup-4**.
- **Repo-server credentials.** The git repo is referenced via HTTPS without
  a credential secret because the repo is intended to be public-readable
  during Phase 1. Private repos (or read-credentials for monorepo hardening)
  land with **TS-152-followup-8** — wire a `argocd-repo-creds` Secret + the
  matching `argocd-repositories` resource.

---

## CI gates (deferred)

The `infra/argocd/` tree currently has no automated lint / validate gate.
Captured as **TS-152-followup-9**:

- `kubectl kustomize` against each subdirectory and pipe to `kubeconform`
  (the AppProject + Application schemas are bundled with the install
  overlay's chart; CI needs to render then validate).
- `kube-linter lint` for security regressions.
- `argocd app diff` against staging on every PR (renders the upcoming
  manifest diff for reviewer context).

Until then, the operator runs `kubectl kustomize` locally against each
subdirectory and reviews the rendered output before applying.

---

## Reference: ArgoCD chart bump path

The chart version pin (`install/kustomization.yaml`: `version: 7.7.0`) is
deliberate — ArgoCD has a history of breaking changes between minor versions
(2.10 → 2.11 changed Redis health checks; 2.11 → 2.12 reworked the resource
hooks). Bump path:

1. Open a PR bumping only the `version:` field.
2. Run `kubectl kustomize --enable-helm infra/argocd/install/ > /tmp/install.yaml`
   and inspect the diff against the prior version's render.
3. Apply to dev first: `kubectl apply -k infra/argocd/install/ --enable-helm`.
4. Verify every Application returns to Synced + Healthy.
5. Soak 24h.
6. Apply to staging.
7. After another soak, apply to prod (manual; the AppProject's syncWindow
   gates the timing).

Chart compatibility matrix (chart ↔ ArgoCD version):

- chart 7.7.x → ArgoCD v2.13.x (current Phase 1 pin)
- chart 8.0.x → ArgoCD v3.0.x (target for TS-152-followup-10 once 3.x soaks)
