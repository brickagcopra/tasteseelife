/**
 * Liveness/readiness probe target for the provider portal (TS-151-followup-1).
 *
 * The `web-app` Kustomize component points its startup/readiness/liveness
 * probes at `/api/healthz` (infra/kubernetes/components/web-app/deployment.yaml).
 * This handler is a deliberate no-op: it asserts the Next.js server process
 * is up and serving, NOT that downstream dependencies (the api-gateway) are
 * reachable — a portal that can render its login page while the gateway is
 * briefly degraded should stay in rotation rather than flap.
 *
 * `force-dynamic` keeps the route from being statically optimized at build
 * time, so every probe hits the running server.
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok', service: 'web-provider' });
}
