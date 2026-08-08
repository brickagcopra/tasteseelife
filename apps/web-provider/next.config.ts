import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Provider portal config (TS-122).
 *
 * Mirrors `apps/web-family/next.config.ts` — same transpile list, same
 * security posture (`poweredByHeader: false`), same strict-mode flag.
 * Server actions are GA in Next.js 15 / React 19 and need no opt-in
 * flag.
 *
 * `output: 'standalone'` (TS-151-followup-1 deploy wiring) emits
 * `.next/standalone/` — a self-contained Node server + pruned
 * node_modules — that the container image runs (infra/docker/nextjs.Dockerfile).
 * `outputFileTracingRoot` pins the monorepo root so the standalone tracer
 * bundles the workspace deps rather than guessing the root.
 */
const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@taste-and-see/design-tokens'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: join(here, '../../'),
  experimental: {
    optimizePackageImports: ['@taste-and-see/design-tokens'],
  },
};

export default config;
