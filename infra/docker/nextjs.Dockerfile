# syntax=docker/dockerfile:1.7
#
# Taste & See — canonical multi-stage Dockerfile for Next.js 15 web apps.
#
# Sibling to nestjs.Dockerfile. Next.js apps need a genuinely different
# runtime shape (the `output: 'standalone'` server + `.next/static` +
# `public`, run via `node <app>/server.js`) than a NestJS `dist/main.js`,
# so per PDD §20.1 this is a legitimate second template rather than a
# per-app Dockerfile.
#
# Usage from repo root:
#   docker build \
#     -f infra/docker/nextjs.Dockerfile \
#     --build-arg SERVICE_PATH=apps/web-family \
#     --build-arg SERVICE_PACKAGE=@taste-and-see/web-family \
#     -t taste-and-see/web-family:dev .
#
# Stages:
#   deps     — install full workspace deps for the target app
#   builder  — `next build` (emits .next/standalone via output:'standalone')
#   runner   — minimal alpine + just the node binary + the standalone tree
#
# Prereqs in the app:
#   - next.config: `output: 'standalone'` + `outputFileTracingRoot` set to
#     the monorepo root (so the standalone tracer bundles workspace deps).
#   - an `app/api/healthz/route.ts` returning 200 (the web-app Kustomize
#     component probes /api/healthz).
#
# References: PDD.md §20.1 (container strategy + size budget); CLAUDE.md §3.

ARG NODE_VERSION=22.20.0
ARG PNPM_VERSION=9.12.3
ARG SERVICE_PATH
ARG SERVICE_PACKAGE

# ---------------------------------------------------------------------------
# Stage 0: upstream-node (alias) — see nestjs.Dockerfile for why a named
# stage is needed (COPY --from does not interpolate ARGs at the ref position).
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS upstream-node

# ---------------------------------------------------------------------------
# Stage 1: deps — install the target app's workspace dep closure.
# ---------------------------------------------------------------------------
FROM upstream-node AS deps
ARG PNPM_VERSION
ARG SERVICE_PATH
ARG SERVICE_PACKAGE

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN apk add --no-cache libc6-compat python3 make g++ \
 && corepack enable \
 && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /repo

# Workspace metadata first so the install layer caches on source-only changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc package.json tsconfig.base.json ./
COPY packages packages
COPY ${SERVICE_PATH}/package.json ${SERVICE_PATH}/package.json

RUN --mount=type=cache,id=tastesee-pnpm-store,target=/pnpm/store \
    pnpm config set store-dir /pnpm/store \
 && pnpm install --frozen-lockfile --filter "${SERVICE_PACKAGE}..."

# ---------------------------------------------------------------------------
# Stage 2: builder — compile workspace deps + `next build`.
# ---------------------------------------------------------------------------
FROM deps AS builder
ARG SERVICE_PATH
ARG SERVICE_PACKAGE

ENV NEXT_TELEMETRY_DISABLED=1

# Source tree on top of the cached deps layer.
COPY ${SERVICE_PATH} ${SERVICE_PATH}

# Build the app AND its transitive workspace deps (`...` selector). The app's
# own `build` script runs `next build`, which emits `.next/standalone`.
RUN pnpm --filter "${SERVICE_PACKAGE}..." build

# Prune the build-time toolchain that Next's file tracer pulls into the
# standalone tree. Sibling of the identical step in nestjs.Dockerfile — same
# CVE class, different mechanism, so the fix has to be applied twice.
#
# There the cause is `pnpm deploy --prod` copying the virtual store wholesale.
# Here it is `outputFileTracingRoot` pointing at the MONOREPO ROOT (required —
# without it the tracer cannot resolve workspace deps): the tracer walks
# `node_modules/.pnpm/` from the root and over-includes, so the devDependency
# closure of a transpiled workspace package (contracts -> vitest -> vite ->
# esbuild) lands in `.next/standalone/node_modules/.pnpm/@esbuild+linux-x64@…`.
#
# Trivy attributed EIGHTEEN Go stdlib findings to that one binary in the
# web-family image — sixteen HIGH and two CRITICAL — because esbuild is a Go
# program and 0.21.5 was built with Go 1.20.12. A Next standalone server
# compiles with SWC and never invokes esbuild at runtime; the CVEs are
# reachable only because a build tool was shipped.
#
# Deleting is again the correct fix rather than a version bump: vite 5 pins
# esbuild, so an override would fight the lockfile to solve the wrong problem.
#
# The assertion is the load-bearing half: if a future Next.js changes its
# tracing semantics — in either direction — this fails the build loudly
# instead of silently shipping the binary again or silently deleting
# something now needed. `find` rather than fixed globs because the standalone
# tree may carry a nested `node_modules` alongside the root-level one.
RUN standalone="${SERVICE_PATH}/.next/standalone" \
 && find "${standalone}" -type d \
      \( -name '@esbuild+*' -o -name 'esbuild@*' -o -name 'vite@*' \
         -o -name 'vitest@*' -o -name 'rollup@*' -o -name '@rollup+*' \) \
      -prune -exec rm -rf {} + \
 && if find "${standalone}" -name 'esbuild' -type f -print -quit | grep -q .; then \
      echo "FATAL: esbuild survived the prune and would ship in the runtime image"; \
      exit 1; \
    fi

# Guarantee a public/ dir exists so the runner COPY is unconditional even
# for apps that ship no static assets yet (web-family / web-marketing today).
RUN mkdir -p ${SERVICE_PATH}/public

# ---------------------------------------------------------------------------
# Stage 3: runner — minimal alpine + node binary + the standalone output.
#
# `output: 'standalone'` with outputFileTracingRoot=<repo root> produces
# `${SERVICE_PATH}/.next/standalone/` whose internal layout is rooted at the
# monorepo root — i.e. it contains `${SERVICE_PATH}/server.js`,
# `${SERVICE_PATH}/.next/`, a pruned `node_modules/`, and `package.json`.
# We copy that tree to /app, then layer the (non-traced) static + public
# assets into their nested locations.
# ---------------------------------------------------------------------------
FROM alpine:3.22 AS runner
ARG SERVICE_PATH

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--enable-source-maps \
    SERVER_ENTRY=${SERVICE_PATH}/server.js

RUN apk add --no-cache libstdc++ libgcc tini \
 && addgroup -S -g 1001 nodejs \
 && adduser -S -u 1001 -G nodejs nodejs

COPY --from=upstream-node /usr/local/bin/node /usr/local/bin/node

WORKDIR /app

# The standalone tree (server + pruned node_modules), rooted at repo root.
COPY --from=builder --chown=nodejs:nodejs /repo/${SERVICE_PATH}/.next/standalone ./
# Static assets are NOT included in the standalone trace — copy them into the
# nested path the server serves them from.
COPY --from=builder --chown=nodejs:nodejs /repo/${SERVICE_PATH}/.next/static ./${SERVICE_PATH}/.next/static
COPY --from=builder --chown=nodejs:nodejs /repo/${SERVICE_PATH}/public ./${SERVICE_PATH}/public

USER nodejs:nodejs

EXPOSE 3000

# The web-app Kustomize component probes /api/healthz; mirror it here so
# `docker run` health matches the k8s probe target.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/healthz').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

# `HOSTNAME=0.0.0.0` (set above) is load-bearing: Next's standalone server.js
# binds to process.env.HOSTNAME, and k8s otherwise injects the pod name there,
# which would make the listener unreachable. Shell-form CMD so $SERVER_ENTRY
# (baked from SERVICE_PATH) expands.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "exec node \"$SERVER_ENTRY\""]
