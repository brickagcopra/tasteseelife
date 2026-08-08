// OpenTelemetry tracing + Prometheus metrics bootstrap MUST run before any
// other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, `ioredis`, NestJS internals, etc. at module-load
// time, so importing those modules first loses their instrumentation
// (TS-306-followup-1d; CLAUDE.md §10; PDD §20.5).
import './observability/bootstrap';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createLogger } from '@taste-and-see/logger';
import { RfcProblemFilter } from '@taste-and-see/nest-common';
import { shutdownSentry } from '@taste-and-see/sentry/node';
import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validate the environment before NestFactory touches anything else
  // — a misconfigured pod should fail to start, not start unhealthy.
  const env = loadEnv();

  const logger = createLogger({
    service: 'api-gateway',
    version: env.SERVICE_VERSION,
  });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  // Trust the upstream proxy / WAF / Cloudflare for X-Forwarded-For. The
  // rate-limit guard relies on this to resolve the real client IP for
  // anonymous traffic (CLAUDE.md §3.1 / §3.7).
  app.set('trust proxy', true);

  app.useGlobalFilters(new RfcProblemFilter());

  // Flush OTel buffers on graceful shutdown so the last batch of spans +
  // metrics reaches the collector (TS-306-followup-1d).
  const onShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'api-gateway shutdown signal received');
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
      subscriptionConfigured: Boolean(env.SUBSCRIPTION_SERVICE_BASE_URL),
      identityConfigured: Boolean(env.IDENTITY_SERVICE_BASE_URL),
      otelTracesEnabled: env.OTEL_TRACES_ENABLED,
      otelMetricsEnabled: env.OTEL_METRICS_ENABLED,
    },
    'api-gateway listening',
  );
}

void bootstrap();
