// OpenTelemetry tracing + Prometheus metrics bootstrap MUST run before any
// other module is imported — `@opentelemetry/auto-instrumentations-node`
// patches `http`, `pg`, `ioredis`, NestJS internals, etc. at module-load
// time, so importing those modules first loses their instrumentation
// (TS-306-followup-1d; CLAUDE.md §10; PDD §20.5).
import './observability/bootstrap';

import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { createLogger } from '@taste-and-see/logger';
import { RfcProblemFilter } from '@taste-and-see/nest-common';
import { shutdownSentry } from '@taste-and-see/sentry/node';
import { shutdownMetrics, shutdownTracing } from '@taste-and-see/tracing';

import { AppModule } from './app.module';
import { loadEnv } from './config/env';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

async function bootstrap(): Promise<void> {
  // Validate the environment before NestFactory touches anything else
  // — a misconfigured pod should fail to start, not start unhealthy.
  const env = loadEnv();

  const logger = createLogger({
    service: 'service-messaging',
    version: env.SERVICE_VERSION,
  });

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();

  // Every error response is RFC 7807 with a `traceId` (CLAUDE.md §5.1).
  app.useGlobalFilters(new RfcProblemFilter());

  // TS-071: install the Socket.IO Redis-adapter so multi-pod fan-out
  // works (PDD §13.1). Must run before `app.listen(...)` so the first
  // connection lands on the adapter-backed server. The adapter wires
  // CORS + path from the validated env.
  const wsAdapter = new RedisIoAdapter(app, env);
  await wsAdapter.connectToRedis();
  app.useWebSocketAdapter(wsAdapter);

  // Clean drain of the Redis pub/sub clients on SIGTERM / SIGINT. The
  // kubelet's TERM → KILL window is ~30s; we tear the clients down
  // synchronously then let Nest's `enableShutdownHooks()` handle the
  // rest of the lifecycle.
  //
  // Why hook process directly instead of registering an
  // OnApplicationShutdown provider? The adapter is set on the app via
  // `useWebSocketAdapter(...)` — it lives outside the DI graph. Using
  // process signals keeps the wiring contained here in main.ts.
  //
  // TS-306-followup-1d folds the OTel exporter flush into this existing
  // handler rather than registering a second one: two `process.once`
  // listeners for the same signal both fire, but they would race over
  // `app.close()` and the flush could run while the adapter is still
  // draining. Last, and after the close, so the final batch of spans and
  // metrics — the ones a terminating pod most needs to have sent — is
  // complete when it ships.
  const shutdown = (): void => {
    void wsAdapter
      .disconnectFromRedis()
      .finally(() => app.close())
      .finally(() => Promise.allSettled([shutdownTracing(), shutdownMetrics(), shutdownSentry()]));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen(env.PORT, '0.0.0.0');

  logger.info(
    {
      port: env.PORT,
      nodeEnv: env.NODE_ENV,
      wsPath: env.WS_PATH,
      otelTracesEnabled: env.OTEL_TRACES_ENABLED,
      otelMetricsEnabled: env.OTEL_METRICS_ENABLED,
    },
    'service-messaging listening',
  );
}

void bootstrap();
