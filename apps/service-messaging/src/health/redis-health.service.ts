import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';

import { ENV_TOKEN } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * Liveness probe for the Redis dependency.
 *
 * The Socket.IO Redis adapter (TS-071) is an explicit durable
 * structure per CLAUDE.md §4.3 — unlike caches, the adapter's
 * availability is on the hot path for cross-pod fan-out. A Redis
 * outage takes the realtime layer back to "single-pod delivery,"
 * which is a measurable regression that should remove the pod from
 * the LB pool until the dependency recovers.
 *
 * **Why a separate ioredis client?** The adapter owns two clients
 * (pub + sub) but neither is exported from the realtime module —
 * keeping them private leaves the adapter free to evolve without
 * coupling the readiness probe to its internals. A third client
 * dedicated to PING is cheap (Redis handles thousands of idle
 * connections) and preserves the layering.
 *
 * **Failure semantics.** `ping()` returns false on any error path
 * (connection refused, timeout, AUTH failure). The health controller
 * surfaces this as 503 from `/readyz`; the kubelet leaves the pod
 * running (no `/healthz` failure) so it can recover when Redis
 * comes back.
 */
@Injectable()
export class RedisHealthService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthService.name);
  private client: Redis | undefined = undefined;

  constructor(@Inject(ENV_TOKEN) private readonly env: Env) {}

  onModuleInit(): void {
    const client = new Redis(this.env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      connectionName: 'service-messaging:health-probe',
    });
    client.on('error', (err) => {
      this.logger.warn({ err: err.message }, 'redis health probe error');
    });
    this.client = client;
  }

  async onModuleDestroy(): Promise<void> {
    const client = this.client;
    if (client !== undefined) {
      client.disconnect();
      this.client = undefined;
    }
  }

  async ping(): Promise<boolean> {
    const client = this.client;
    if (client === undefined) return false;
    try {
      const response = await client.ping();
      return response === 'PONG';
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : 'unknown' },
        'redis ping failed',
      );
      return false;
    }
  }
}
