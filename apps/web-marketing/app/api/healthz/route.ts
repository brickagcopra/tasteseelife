/**
 * Liveness/readiness probe target for the marketing site (TS-151-followup-1).
 *
 * The `web-app` Kustomize component points its startup/readiness/liveness
 * probes at `/api/healthz` (infra/kubernetes/components/web-app/deployment.yaml).
 * This handler is a deliberate no-op asserting the Next.js server process is
 * up and serving. The marketing site has no authenticated backend
 * dependency, so liveness == process-up.
 *
 * `force-dynamic` keeps the route from being statically optimized at build
 * time, so every probe hits the running server.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok', service: 'web-marketing' });
}
