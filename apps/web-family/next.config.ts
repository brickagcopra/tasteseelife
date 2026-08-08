import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Family portal config (TS-121).
 *
 * - Transpiles the workspace `design-tokens` package so its CSS-from-JS
 *   exports work in the Next.js bundle (the package ships dist/ but
 *   transpile picks up the in-place source for HMR during dev).
 * - `poweredByHeader: false` — defence-in-depth; never advertise the
 *   framework on the wire (CLAUDE.md §3 — minimize information leakage).
 * - `reactStrictMode: true` — catches accidental side effects in
 *   server-component / suspense boundaries early.
 * - `output: 'standalone'` (TS-151-followup-1 deploy wiring) emits
 *   `.next/standalone/` — a self-contained Node server + pruned
 *   node_modules — that the container image runs as
 *   `node apps/web-family/server.js` (infra/docker/nextjs.Dockerfile).
 *   `outputFileTracingRoot` pins the monorepo root so the standalone
 *   tracer bundles the workspace deps rather than guessing the root.
 *
 * No `experimental.serverActions` flag — server actions are GA in
 * Next.js 15 / React 19 and require no opt-in.
 */
const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@taste-and-see/contracts', '@taste-and-see/design-tokens'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: join(here, '../../'),
  experimental: {
    optimizePackageImports: ['@taste-and-see/contracts', '@taste-and-see/design-tokens'],
  },
};

export default config;
