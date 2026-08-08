# `infra/docker/`

Canonical Docker assets for Taste & See services. One template, every service.

## Files

| File                              | Purpose                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `nestjs.Dockerfile`               | Multi-stage Dockerfile for any NestJS service in this monorepo. Parametrized via `--build-arg`. |
| `../../.dockerignore` (repo-root) | Build-context filter (BuildKit reads it from the context root, not from this directory).        |

## Building a service image

From the repo root:

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-identity \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-identity \
  -t taste-and-see/service-identity:dev \
  .
```

The two required build args:

| Arg               | Meaning                                                                      | Example                           |
| ----------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| `SERVICE_PATH`    | Path to the service's workspace directory, relative to repo root.            | `apps/service-identity`           |
| `SERVICE_PACKAGE` | The `name` field from the service's `package.json` (the pnpm filter target). | `@taste-and-see/service-identity` |

Optional build args (defaults are aligned with the repo's `.nvmrc` and `packageManager` pin):

| Arg            | Default   |
| -------------- | --------- |
| `NODE_VERSION` | `22.20.0` |
| `PNPM_VERSION` | `9.12.3`  |

Tip: when iterating on the Dockerfile itself, prefix the build with
`DOCKER_BUILDKIT=1` and pass `--progress=plain` to see each stage's full log.

## Stage layout

```
upstream-node  → node:${NODE_VERSION}-alpine alias used as the COPY source for
                 the runtime `node` binary (COPY --from cannot interpolate ARGs)
deps           → install workspace deps for the target service (cached on lockfile)
builder        → compile the service + transitive workspace deps; pnpm deploy --prod
runner         → fresh alpine:3.22 + tini + non-root user + just the `node`
                 binary copied from upstream-node + dist + prod node_modules
```

Only `runner` ships. The build toolchain (`python3`, `make`, `g++`) and the
full workspace `node_modules` graph are discarded with the intermediate
stages. The runner deliberately starts from `alpine:3.22` rather than the
upstream `node:*-alpine` image so we avoid shipping `npm`, `yarn`,
`corepack`, and the upstream's cached docs / headers — none of which a
compiled NestJS service needs at runtime. `RUN rm -rf …` does not reclaim
that space (overlayfs records whiteouts in a new layer rather than shrinking
the base), so the only mechanism that actually drops the bloat is starting
from a fresh base and copying in only what's needed. Result: `~166 MB` of
real layer content vs. `~260 MB` if we'd built `FROM node:22-alpine`.

## Onboarding a new service

1. Create the service under `apps/<service-name>/` following the repo's
   NestJS skeleton conventions (see `apps/service-identity/` as the reference).
2. Confirm `package.json` declares an `"name"` matching `@taste-and-see/<service-name>`.
3. Add a one-line CI build invocation (lands with TS-009g) using the args above.
4. **No per-service Dockerfile is required** unless the service has truly
   bespoke needs (native deps, alternate base image, multi-binary output).
   In that case, create `apps/<service-name>/Dockerfile` as a thin override
   that `FROM`s an internally-published base — _not_ a fork of this template.

## Why these choices

- **Node 22.20.0 binary copied onto `alpine:3.22`** — matches `.nvmrc` and
  the `engines.node` pin so the runtime executes the same Node minor as
  local development and CI, which is the runner shape PDD §20.1 prescribes.
  The runner starts from `alpine:3.22` rather than `node:22-alpine`
  directly so we avoid shipping `npm`, `yarn`, and `corepack` (none of
  which a compiled service needs at runtime); see "Stage layout" above
  for the rationale.
- **`tini` as PID 1** — clean SIGTERM propagation under K8s pod
  termination. Without it, Node receives signals indirectly and graceful
  shutdown is unreliable.
- **Non-root `nodejs:nodejs` user (uid/gid 1001)** — matches K8s
  PodSecurityStandards baseline → restricted progression
  (PDD §20.2). Fixed UID/GID makes volume-mount ownership predictable
  in StatefulSets.
- **`pnpm deploy --prod`** — produces a self-contained, production-only
  tree at `/deploy`. Workspace packages are resolved and flattened into
  `node_modules`, so the runtime image needs no awareness of the monorepo
  layout. (The `--legacy` flag pnpm 9 once accepted has been removed in
  9.12.x; modern pnpm produces the right output without it.)
- **BuildKit cache mount on `/pnpm/store`** — repeated builds (across
  services or PR runs) reuse downloaded tarballs without inflating the
  image. The cache is workspace-keyed (`id=tastesee-pnpm-store`) so it does
  not clash with other Docker projects on the same host.
- **HEALTHCHECK targets `/healthz`** — every NestJS service exposes this
  endpoint (see `apps/service-identity/src/modules/health/`). K8s liveness
  probes the same path; readiness uses `/readyz`.

## CI integration

Per-service image-build workflows landed with TS-009g. The pipeline is a
two-piece shape:

| File                                           | Role                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.github/workflows/build-push-image.yml`       | **Reusable workflow** (workflow_call-only). Builds via this Dockerfile, pushes to ghcr.io, signs with cosign (keyless OIDC), scans with Trivy. |
| `.github/workflows/service-identity-build.yml` | **Per-service trigger** for `service-identity`. Calls the reusable workflow on push to `main`, then bumps the dev overlay's `newTag`.          |

On every push to `main` that touches a wired service's files, the per-
service workflow:

1. Builds the image with `infra/docker/nestjs.Dockerfile` and the service's
   `--build-arg SERVICE_PATH=...` / `SERVICE_PACKAGE=...`.
2. Pushes to `ghcr.io/brickagcopra/<service>` with two tags:
   - `sha-<short-sha>` — immutable; this is what the GitOps overlay pins to.
   - `<branch-slug>` (typically `main`) — mutable; debugging aid only.
3. Attaches SLSA provenance + SBOM attestations to the image index.
4. Signs the resulting digest with cosign keyless (Sigstore/Fulcio + Rekor).
5. Trivy-scans the pushed digest (HIGH/CRITICAL fails the job).
6. Rewrites the `newTag:` field in
   `infra/kubernetes/overlays/dev/kustomization.yaml`'s `images:` entry for
   that service and commits back to `main` with `[skip ci]`.

ArgoCD's `platform-dev` Application auto-syncs from `main` (per TS-152), so
the dev cluster rolls onto the new tag within 1-2 min of the bumper commit.

**Staging + prod are NOT auto-bumped.** Promotion is operator-driven via a
deliberate PR per CLAUDE.md §11 + PDD §11 soak-then-promote. The promotion
PR shape is captured as TS-009g-followup-2.

### Verifying a pushed image

Cosign keyless signing means anyone with the public Rekor log can verify a
signature was produced by this repo's GitHub Actions workflow. From any
workstation with `cosign` installed:

```bash
cosign verify \
  --certificate-identity-regexp \
    '^https://github\.com/brickagcopra/.+/\.github/workflows/build-push-image\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/brickagcopra/service-identity@sha256:<digest>
```

A successful verify proves:

- The image at that digest was built by the `build-push-image.yml`
  reusable workflow on the `main` branch of the `tastesee/<repo>`
  repository.
- The signature is recorded in the public Rekor transparency log, so any
  later attempt to "un-sign" is detectable.

The certificate-identity regex narrows the trust window to exactly this
workflow file; a rogue PR introducing a different signing workflow would
fail verification.

## Adding a new service to the build pipeline

The three-step recipe for wiring an existing NestJS service:

1. **Confirm the K8s base exists.** Each service needs
   `infra/kubernetes/services/<svc>/kustomization.yaml` consuming the
   `nestjs-service` component (the canonical example is
   `infra/kubernetes/services/service-identity/`). Per-service bases for
   the remaining ~20 apps are gated on TS-151-followup-1.
2. **Confirm the overlay `images:` entries exist.** Each of
   `infra/kubernetes/overlays/{dev,staging,prod}/kustomization.yaml` needs
   an `images:` entry naming `ghcr.io/brickagcopra/<svc>` with a default
   `newTag:` (typically the env name). The TS-009g bumper will rewrite the
   dev overlay's `newTag` on every successful build.
3. **Create `.github/workflows/<svc>-build.yml`** as a thin caller of the
   reusable workflow. Mirror the shape of
   `service-identity-build.yml` — three load-bearing decisions:
   - `paths:` filter listing the service directory + workspace deps it
     imports (use `git log --name-only -- apps/<svc>/` to discover the
     transitive set) + `infra/docker/**` + `pnpm-lock.yaml`.
   - `permissions:` on the `build` job must repeat the four privileges
     declared on the reusable workflow's job — caller + callee intersect.
   - Inputs match the per-service base name + image name exactly. Drift
     here means the bumper edits the wrong overlay entry.

For services that are NOT in the K8s overlay yet, skip the bumper job
entirely (omit the `bump-dev-overlay:` block) — the build will still push

- sign + scan but no GitOps manifest gets touched. This is useful for an
  "early adopter" service that wants image artifacts before its K8s base
  lands.

## Verifying locally

The template's acceptance criterion (TS-010) is that any compiled NestJS
service builds an image close to the upstream Node binary's footprint. To
re-validate after touching the template, build any real service (the
canonical one is `service-identity` — see TS-010-followup-2 for the
retirement of the stand-in `service-hello` validation app):

```bash
docker build \
  -f infra/docker/nestjs.Dockerfile \
  --build-arg SERVICE_PATH=apps/service-identity \
  --build-arg SERVICE_PACKAGE=@taste-and-see/service-identity \
  -t taste-and-see/service-identity:dev .

docker images taste-and-see/service-identity:dev --format '{{.Size}}'
docker save taste-and-see/service-identity:dev | wc -c       # compressed pull size
docker history taste-and-see/service-identity:dev            # per-layer breakdown
```

### Size measurements — three numbers, not one

A built image has three different "sizes" you'll see in tooling, and they
disagree on purpose:

| Number                      | Source                                              | What it is                                                                          |
| --------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Compressed pull (~54 MB)    | `docker save … \| wc -c`, OCI manifest size         | Bytes that flow over the wire when K8s pulls the image. Drives pod start time.      |
| Layer-history sum (~166 MB) | `docker history`, sum of layer sizes                | What's actually on disk inside the container. Drives node-disk pressure.            |
| Virtual size (~219 MB)      | `docker images` Size column, `docker image inspect` | Same content as layer-history but reported with Docker Desktop accounting overhead. |

PDD §20.1 sets two directional budgets against the Node 22 runtime: **compressed pull < 75 MB** and **virtual size < 250 MB**. Today the measured numbers are ~54 MB / ~219 MB — both comfortably inside the budget. Compressed pull is the operationally-meaningful figure (it drives K8s pod-start time and registry egress); virtual size matters for node-disk pressure. The budgets recalibrate on every Node LTS bump — the v22 binary unpacks at ~120 MB vs. ~95 MB for v20, so the previous Phase-0 "200 MB on `node:20-alpine`" framing no longer applies. See PDD §20.1 for the current target.

### Investigating size regressions

If any of the three numbers grow materially against the baseline:

- A stray dev-dep crept into the runtime `package.json` (check the deploy stage's `--prod` flag).
- A workspace package started shipping unneeded files (check the consumer's `files` allowlist).
- The upstream `node:${NODE_VERSION}-alpine` shipped a larger Node binary in a patch bump (rare; visible as a jump in the `COPY /usr/local/bin/node` layer).
