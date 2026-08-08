// OpenTelemetry tracing + Prometheus metrics bootstrap MUST run before any
// other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, `ioredis`, NestJS internals, etc. at module-load
// time, so importing those modules first loses their instrumentation
// (TS-050-followup-1; CLAUDE.md §10; PDD §20.5).
import './observability/bootstrap';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
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
    service: 'service-provider',
    version: env.SERVICE_VERSION,
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  // Every error response is RFC 7807 with a `traceId` (CLAUDE.md §5.1).
  app.useGlobalFilters(new RfcProblemFilter());

  // Flush OTel buffers on graceful shutdown so the last batch of spans +
  // metrics reaches the collector (TS-050-followup-1).
  const onShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'service-provider shutdown signal received');
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
    'service-provider listening',
  );
}

void bootstrap();
