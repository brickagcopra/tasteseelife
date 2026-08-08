// OpenTelemetry tracing + Prometheus metrics bootstrap MUST run before any
// other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, NestJS internals, etc. at module-load time, so
// importing those modules first loses their instrumentation
// (TS-041a-followup-4; CLAUDE.md §10; PDD §20.5).
import './observability/bootstrap';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger } from '@taste-and-see/logger';
import { RfcProblemFilter } from '@taste-and-see/nest-common';
import { shutdownSentry } from '@taste-and-see/sentry/node';
import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';
import express from 'express';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { CHECKR_WEBHOOK_PATH } from './modules/checkr/checkr.constants';
import { STRIPE_WEBHOOK_PATH } from './modules/stripe/stripe.constants';

async function bootstrap(): Promise<void> {
  // Validate the environment before NestFactory touches anything else — a
  // misconfigured pod (missing STRIPE_WEBHOOK_SECRET especially) should fail
  // to start, not start unhealthy and ack 200 to whatever shows up.
  const env = loadEnv();

  const logger = createLogger({
    service: 'service-webhook',
    version: env.SERVICE_VERSION,
  });

  // bodyParser:false disables Nest's built-in JSON parser so we can
  // install per-route body parsers below. This is the canonical Stripe
  // recommendation — `stripe.webhooks.constructEvent` validates the
  // signature against the *byte-exact* request body, and Nest's default
  // JSON parser would consume the body and present us with a re-serialised
  // object (re-serialising changes whitespace, key ordering, and number
  // formatting, which all break the signature).
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  app.enableShutdownHooks();

  // Stripe webhook endpoint: register a `raw` body parser scoped to the
  // exact path. The verifier service reads `req.body` as a `Buffer`.
  app.use(
    STRIPE_WEBHOOK_PATH,
    express.raw({
      type: 'application/json',
      // Stripe documents a 256 KB ceiling on event payloads; we double it
      // to give headroom (~512 KB) without making decompression-bomb attacks
      // trivially memory-expensive.
      limit: '512kb',
    }),
  );

  // Checkr webhook endpoint: same raw-body discipline — the HMAC-SHA256
  // verification has to run against the byte-exact request body, so
  // Nest's default JSON parser must not consume it first. Checkr's
  // event payloads cap below 64 KiB in practice; we match Stripe's
  // 512 KB ceiling to keep the body-parser config consistent.
  app.use(
    CHECKR_WEBHOOK_PATH,
    express.raw({
      type: 'application/json',
      limit: '512kb',
    }),
  );

  // Everything else gets the standard JSON parser. Order matters — the
  // path-specific `raw` parsers above must register first so Express
  // matches the more specific route handlers.
  app.use(express.json({ limit: '512kb' }));

  // Every error response is RFC 7807 with a `traceId` (CLAUDE.md §5.1).
  app.useGlobalFilters(new RfcProblemFilter());

  // Flush OTel buffers on graceful shutdown so the last batch of spans +
  // metrics reaches the collector (TS-041a-followup-4).
  const onShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'service-webhook shutdown signal received');
    try {
      await app.close();
    } finally {
      await Promise.allSettled([shutdownTracing(), shutdownMetrics(), shutdownSentry()]);
    }
  };
  process.once('SIGTERM', (s) => void onShutdown(s));
  process.once('SIGINT', (s) => void onShutdown(s));

  await app.listen(env.PORT, '0.0.0.0');

  logger.info(
    {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      otelTracesEnabled: env.OTEL_TRACES_ENABLED,
      otelMetricsEnabled: env.OTEL_METRICS_ENABLED,
    },
    'service-webhook listening',
  );
}

void bootstrap();
