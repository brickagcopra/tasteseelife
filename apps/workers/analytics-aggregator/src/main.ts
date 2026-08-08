// OpenTelemetry tracing + Prometheus metrics + Sentry bootstrap MUST run
// before any other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, `ioredis`, NestJS internals, etc. at module-load time,
// so importing those modules first loses their instrumentation
// (TS-504-followup-2a-2; CLAUDE.md §10; PDD §20.5).
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
  // Validate the env before NestFactory touches anything — a misconfigured pod
  // should fail to start, not start unhealthy.
  const env = loadEnv();

  const logger = createLogger({
    service: 'worker-analytics-aggregator',
    version: env.SERVICE_VERSION,
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.useGlobalFilters(new RfcProblemFilter());

  // Flush OTel + Sentry buffers on graceful shutdown so the last batch of
  // spans, metrics and error events reaches its destination. `app.close()`
  // drains in-flight work via Nest's shutdown hooks first.
  const onShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'worker-analytics-aggregator shutdown signal received');
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
      enabled: env.ANALYTICS_AGGREGATOR_ENABLED,
      runHourUtc: env.ANALYTICS_AGGREGATOR_RUN_HOUR_UTC,
      tickMs: env.ANALYTICS_AGGREGATOR_SCHEDULER_TICK_MS,
      analyticsServiceBaseUrl: env.ANALYTICS_SERVICE_BASE_URL,
    },
    'worker-analytics-aggregator listening',
  );
}

void bootstrap();
