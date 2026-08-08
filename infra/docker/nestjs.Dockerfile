# syntax=docker/dockerfile:1.7
#
# Taste & See — canonical multi-stage Dockerfile for NestJS services.
#
# One template, every service. Parametrized via build args so each service
# Dockerfile is one-line wrapper at most. See infra/docker/README.md.
#
# Usage from repo root:
#   docker build \
#     -f infra/docker/nestjs.Dockerfile \
#     --build-arg SERVICE_PATH=apps/service-identity \
#     --build-arg SERVICE_PACKAGE=@taste-and-see/service-identity \
#     -t taste-and-see/service-identity:dev .
#
# Stages:
#   deps          — install full workspace deps for the target service
#   builder       — compile the service + all its workspace dependencies
#   runner        — minimal alpine runtime with prod-only node_modules (DEFAULT)
#   migrator-cli  — a standalone npm install of the Prisma CLI + musl engines
#   migrator      — one-shot `prisma migrate deploy` image (TS-151-followup-12)
#
# `runner` is the default target and callers MUST pass `--target runner`
# explicitly (the reusable build workflow does). `migrator` is declared after
# it, and BuildKit treats the LAST stage as the default when no target is
# given — an unpinned build would otherwise silently produce a migrator image
# where a service image was meant.
#
# References:
#   PDD.md §20.1 (container strategy), §20.2 (K8s topology)
#   CLAUDE.md §3 (security), §4.4 (migrations), §17.14 (long-running sync work)

ARG NODE_VERSION=22.20.0
ARG PNPM_VERSION=9.12.3
ARG SERVICE_PATH
ARG SERVICE_PACKAGE
# Pinned to the exact `prisma` devDependency every schema-owning service
# declares (5.22.0, uniform across all 20). The CLI that applies a migration
# must not drift ahead of the client that reads the resulting schema, and a
# floating version here would be a silent, deploy-time-only divergence.
ARG PRISMA_VERSION=5.22.0

# ---------------------------------------------------------------------------
# Stage 0: upstream-node (alias)
# Pulled separately so the runner stage can `COPY --from=upstream-node …`.
# `COPY --from=<image>` does not interpolate ARGs at the image-reference
# position; using a named stage sidesteps that limitation.
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS upstream-node

# ---------------------------------------------------------------------------
# Stage 1: deps
# Install workspace dependencies for the target service and its transitive
# workspace dependencies. Runs as root since pnpm needs to write to /repo.
# Uses BuildKit cache mount for the pnpm store so repeated builds reuse
# downloaded tarballs across services.
# ---------------------------------------------------------------------------
FROM upstream-node AS deps
ARG PNPM_VERSION
ARG SERVICE_PATH
ARG SERVICE_PACKAGE

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# libc6-compat: some npm packages ship glibc-linked prebuilt binaries
# python3/make/g++: required when a transitive dep needs node-gyp; cheap to
#   include here since the deps stage is discarded from the final image.
RUN apk add --no-cache libc6-compat python3 make g++ \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Copy workspace metadata first so pnpm install can be cached when only
# source code (not deps) changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json tsconfig.base.json ./

# Workspace package manifests must be present for pnpm to resolve the graph.
# We bring all packages/* manifests in (cheap, just package.json files) and
# only the target service's manifest. Other apps stay out of this stage.
COPY packages packages
COPY ${SERVICE_PATH}/package.json ${SERVICE_PATH}/package.json

RUN --mount=type=cache,id=tastesee-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter "${SERVICE_PACKAGE}..."

# ---------------------------------------------------------------------------
# Stage 2: builder
# Bring in the service source, compile it (and its workspace deps), then use
# `pnpm deploy --prod` to materialize a self-contained directory with only
# what the runtime needs. Workspace deps are flattened into node_modules.
# ---------------------------------------------------------------------------
FROM deps AS builder
ARG SERVICE_PATH
ARG SERVICE_PACKAGE

# Copy the service source tree on top of the cached deps layer.
COPY ${SERVICE_PATH} ${SERVICE_PATH}

# Generate the Prisma client BEFORE building (TS-502).
#
# This step did not exist, and nothing else supplied the client: there is no
# postinstall hook, and `prisma/generated` is both gitignored and (since
# TS-502) dockerignored, so on a clean checkout it is simply absent. Every
# service's `prisma.service.ts` imports `../../prisma/generated`, so `tsc`
# needs it present — the build fails without this, which is the honest
# failure. Before TS-501 the client resolved to a 0-model postinstall stub
# and the image built happily, then died at boot with "@prisma/client did
# not initialize yet".
#
# Guarded on the schema existing because this same template builds the
# workers and the api-gateway, none of which own a Prisma schema.
#
# `binaryTargets` in every schema already includes `linux-musl-openssl-3.0.x`,
# so generating here — on alpine — produces the engine the runner needs.
RUN if [ -f "${SERVICE_PATH}/prisma/schema.prisma" ]; then \
      pnpm --filter "${SERVICE_PACKAGE}" exec prisma generate; \
    fi

# Build the service AND its transitive workspace dependencies. The trailing
# `...` selector tells pnpm to include dependencies of the matched filter.
RUN pnpm --filter "${SERVICE_PACKAGE}..." build

# Materialize a deploy-ready tree at /deploy. `pnpm deploy --prod` copies
# only production dependencies and inlines workspace packages.
RUN pnpm --filter "${SERVICE_PACKAGE}" deploy --prod /deploy

# Prune the build-time toolchain that `pnpm deploy --prod` leaves behind.
#
# `pnpm why esbuild` reports it as devDependencies-only (vitest -> vite ->
# esbuild), yet pnpm 9's `deploy` copies the virtual store wholesale and the
# binary lands at `/app/node_modules/.pnpm/@esbuild+linux-x64@…/bin/esbuild` in
# the shipped image. The first Trivy run found it there and attributed EIGHTEEN
# HIGH-severity Go stdlib CVEs to it — esbuild is a Go program, and 0.21.5 was
# built with Go 1.20.12.
#
# Deleting it is the correct fix rather than a version bump: a bundler has no
# business in a runtime whose entrypoint is `node dist/main.js`, and the CVEs
# are only reachable because a build tool was shipped. This also removes the
# tempting alternative of overriding esbuild to a newer release, which vite 5
# pins and which would be fighting the lockfile to solve the wrong problem.
#
# The assertion is the load-bearing half: if a future pnpm changes `deploy`
# semantics — in either direction — this fails the build loudly instead of
# silently shipping the binary again or silently deleting something now needed.
RUN rm -rf /deploy/node_modules/.pnpm/@esbuild+* \
           /deploy/node_modules/.pnpm/esbuild@* \
           /deploy/node_modules/.pnpm/vite@* \
           /deploy/node_modules/.pnpm/vitest@* \
           /deploy/node_modules/.pnpm/rollup@* \
           /deploy/node_modules/.pnpm/@rollup+* \
 && if find /deploy/node_modules -name 'esbuild' -type f -print -quit | grep -q .; then \
      echo "FATAL: esbuild survived the prune and would ship in the runtime image"; \
      exit 1; \
    fi

# Stage the generated client separately (TS-502). `pnpm deploy` copies
# production dependencies and workspace packages — `prisma/generated` lives
# outside `node_modules`, so it is not carried and the runner would start
# without a client.
#
# The directory is created unconditionally, even when empty, so the runner's
# COPY has a source in every case: `COPY` fails on a missing path, and this
# template also builds the schema-less workers.
RUN mkdir -p /deploy-prisma \
 && if [ -d "${SERVICE_PATH}/prisma/generated" ]; then \
      cp -R "${SERVICE_PATH}/prisma/generated" /deploy-prisma/generated; \
    fi

# ---------------------------------------------------------------------------
# Stage 3: runner
# Minimal alpine + tini + non-root user + just the `node` binary copied from
# the official `node:${NODE_VERSION}-alpine` image. No npm, no yarn, no
# corepack, no headers — none of those are needed to execute `node dist/main.js`.
#
# Why not `FROM node:${NODE_VERSION}-alpine` directly? Because that image
# ships ~150 MB of upstream payload (the node binary + npm + yarn + headers +
# cached docs). `RUN rm -rf …` doesn't reclaim that space — overlayfs records
# whiteouts in a new layer rather than shrinking the base, so `docker images`
# size stays stuck near the upstream's. The only way to actually drop the
# bloat is to start from a fresh `alpine:` and copy in only what we need.
# Measured against this Dockerfile: ~54 MB compressed pull, ~166 MB layer-
# history sum, ~219 MB virtual — all comfortably inside the PDD §20.1
# budget (compressed pull < 75 MB, virtual < 250 MB on Node 22).
#
# References: PDD §20.1 (container strategy + size budget), CLAUDE.md §3
# (least-attack-surface).
# ---------------------------------------------------------------------------
FROM alpine:3.22 AS runner

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

# `libstdc++` is required by Node's V8 (libstdc++.so.6).
# `libgcc` provides libgcc_s.so.1 used by libstdc++.
# `tini` gives us a real PID 1 — clean SIGTERM propagation under K8s pod
# termination; without it Node receives signals indirectly and graceful
# shutdown is unreliable.
# `openssl` is required by Prisma's query engine (TS-502). Without it the
# engine loader cannot detect the system OpenSSL version, silently falls back
# to assuming `openssl-1.1.x`, and then fails to load a
# `libquery_engine-linux-musl.so.node` that does not exist here — every
# schema-owning service dies at its first query with "Error loading shared
# library libssl.so.1.1". Alpine 3.22 ships OpenSSL 3.x, which matches the
# `linux-musl-openssl-3.0.x` binary target every schema declares.
RUN apk add --no-cache libstdc++ libgcc tini openssl \
 && addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nodejs

# Bring in just the node binary from the official image. The upstream ships
# additional shared assets under /usr/local/include/node and /usr/local/share
# but the binary alone is everything needed to execute compiled JS.
COPY --from=upstream-node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /deploy/package.json ./package.json
COPY --from=builder --chown=nodejs:nodejs /deploy/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /deploy/dist ./dist

# The generated Prisma client (TS-502). Lands at `/app/prisma/generated`,
# which is what `/app/dist/prisma/prisma.service.js` resolves
# `../../prisma/generated` to — the same one relative path that works from
# both `src/` and `dist/`, per TS-500. Empty for the workers and the
# api-gateway, which own no schema.
COPY --from=builder --chown=nodejs:nodejs /deploy-prisma ./prisma

USER nodejs:nodejs

EXPOSE 3000

# /healthz is the convention every NestJS service exposes (see
# apps/service-identity/src/modules/health/ for the canonical
# implementation). Liveness in K8s should target this same endpoint;
# readiness should target /readyz which checks downstream deps.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------
# Stage 4: migrator-cli
# A standalone `npm install prisma` in an empty directory.
#
# Why npm and not the workspace's own pnpm tree: `prisma` is a devDependency,
# so `pnpm deploy --prod` (stage 2) deliberately drops it, and pnpm's
# node_modules is a forest of symlinks into a content-addressed store that
# does not survive a `COPY --from`. A flat, self-contained npm install is the
# one shape that copies cleanly into a scratch-ish runtime.
#
# Installing on alpine is what makes this correct rather than merely
# convenient: the `@prisma/engines` postinstall resolves the engine for the
# CURRENT platform, so building here yields the `linux-musl-openssl-3.0.x`
# schema-engine — the same target every schema declares in `binaryTargets`.
# ---------------------------------------------------------------------------
FROM upstream-node AS migrator-cli
ARG PRISMA_VERSION

WORKDIR /prisma-cli
RUN npm install --no-save --no-audit --no-fund "prisma@${PRISMA_VERSION}"

# ---------------------------------------------------------------------------
# Stage 5: migrator
# One-shot image that runs `prisma migrate deploy` for exactly one service.
#
# **Why this image exists at all.** Nothing on this platform applied database
# migrations. The `runner` stage above carries the GENERATED CLIENT but no
# `schema.prisma`, no `prisma/migrations/` tree, and no Prisma CLI — all three
# are required by `migrate deploy` and all three are absent by design (a CLI in
# a long-running runtime is attack surface, per the size/least-surface
# rationale on stage 3). CLAUDE.md §4.4 says migrations run through CI before
# deployment; no such CI step was ever built, and on a single-VPS GitOps
# deployment there is no network path from a GitHub runner to a Postgres on a
# private VLAN anyway. So the migration runs IN the cluster, as an ArgoCD
# PreSync hook, from this image.
#
# **One image per service, not one shared migrator.** A shared image carrying
# all 20 schemas would be fewer artefacts, but it puts every bounded context's
# schema in one blast radius and reads against CLAUDE.md §2.3. Per-service
# keeps the existing convention (per-service base, per-service workflow,
# per-service Secret) and means a Job can only ever reach its own database,
# because it only ever has its own `DATABASE_URL`.
#
# **Same node binary, same openssl as the runner** — the engine loader's
# OpenSSL detection is exactly as load-bearing here as it is at stage 3.
# ---------------------------------------------------------------------------
FROM alpine:3.22 AS migrator
ARG SERVICE_PATH

# CHECKPOINT_DISABLE stops the CLI phoning home for a version check on every
# run: it is a network call this Job should not need, on a startup path that
# gates the whole sync, and it writes to a cache directory that
# `readOnlyRootFilesystem: true` does not give it.
ENV NODE_ENV=production \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    HOME=/tmp

RUN apk add --no-cache libstdc++ libgcc tini openssl \
 && addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nodejs

COPY --from=upstream-node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

COPY --from=migrator-cli --chown=nodejs:nodejs /prisma-cli/node_modules ./node_modules

# The schema and the migration history — the two inputs `migrate deploy` reads.
# `prisma/generated` is dockerignored and irrelevant here: `migrate deploy`
# never generates a client, it only replays committed SQL.
COPY --chown=nodejs:nodejs ${SERVICE_PATH}/prisma/schema.prisma ./prisma/schema.prisma
COPY --chown=nodejs:nodejs ${SERVICE_PATH}/prisma/migrations ./prisma/migrations

USER nodejs:nodejs

# Invoked through `node <cli entrypoint>` rather than `npx`: npx resolves
# through a writable npm cache that the restricted PodSecurity context does
# not provide, and it would happily reach the network to fetch a missing
# package. This path is the installed CLI or it is nothing.
#
# `migrate deploy` is the only safe command here — it applies pending
# migrations and never generates, never resets, and never prompts. It exits
# non-zero on a failed migration, which is what makes the PreSync hook abort
# the sync rather than roll pods onto a schema that did not land.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "/app/node_modules/prisma/build/index.js", "migrate", "deploy", "--schema=/app/prisma/schema.prisma"]
