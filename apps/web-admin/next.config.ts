import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NextConfig } from 'next';

/**
 * Admin console config (TS-123).
 *
 * Mirrors `apps/web-provider/next.config.ts`. Server actions are GA in
 * Next.js 15 / React 19 and need no opt-in flag.
 *
 * `poweredByHeader: false` is non-negotiable on the admin surface — no
 * server-fingerprint leakage on the most sensitive console.
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
  transpilePackages: [
    '@taste-and-see/auth-sdk',
    '@taste-and-see/contracts',
    '@taste-and-see/design-tokens',
    // TipTap CMS editor (TS-281 / ADR-0004) — transpiled so its ESM +
    // tiptap-markdown / markdown-it deps bundle cleanly on the authoring routes.
    'tiptap-markdown',
  ],
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: join(here, '../../'),
  experimental: {
    optimizePackageImports: ['@taste-and-see/design-tokens'],
  },
};

export default config;
