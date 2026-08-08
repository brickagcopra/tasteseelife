import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Marketing site config — minimal. Transpile the workspace `design-tokens`
 * package so its CSS-from-JS exports work in the Next.js bundle (the package
 * ships dist/ but transpile picks up the in-place source for HMR during dev).
 *
 * `output: 'standalone'` (TS-151-followup-1 deploy wiring) emits
 * `.next/standalone/` that the container image runs as
 * `node apps/web-marketing/server.js` (infra/docker/nextjs.Dockerfile);
 * `outputFileTracingRoot` pins the monorepo root for the standalone tracer.
 */
const here = dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@taste-and-see/contracts', '@taste-and-see/design-tokens'],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: join(here, '../../'),
  experimental: {
    optimizePackageImports: ['@taste-and-see/design-tokens'],
  },
};

export default config;
