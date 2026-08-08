// OpenTelemetry tracing + Prometheus metrics bootstrap MUST run before any
// other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, NestJS internals, etc. at module-load time, so
// importing those modules first loses their instrumentation
// (TS-111-followup-4; CLAUDE.md §10; PDD §20.5).
import './observability/bootstrap';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger } from '@taste-and-see/logger';
import { RfcProblemFilter } from '@taste-and-see/nest-common';
import { shutdownSentry } from '@taste-and-see/sentry/node';
import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';

import { AppModule } from './app.module';
import { isSearchBackendStubMode, loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  // Validate the environment before NestFactory touches anything else
  // — a misconfigured pod should fail to start, not start unhealthy.
  const env = loadEnv();

  const logger = createLogger({
    service: 'service-search',
    version: env.SERVICE_VERSION,
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  app.useGlobalFilters(new RfcProblemFilter());

  // Flush OTel buffers on graceful shutdown so the last batch of spans +
  // metrics reaches the collector (TS-111-followup-4).
  const onShutdown = async (signal: NodeJS.Signals): Promise<void> => {
    logger.info({ signal }, 'service-search shutdown signal received');
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
      searchBackendStubMode: isSearchBackendStubMode(env),
      providerIndexName: env.SEARCH_PROVIDER_INDEX_NAME,
      otelTracesEnabled: env.OTEL_TRACES_ENABLED,
      otelMetricsEnabled: env.OTEL_METRICS_ENABLED,
    },
    'service-search listening',
  );
}

void bootstrap();
