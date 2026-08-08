import { Inject, Injectable } from '@nestjs/common';

import { ENV_TOKEN } from '../../../config/config.module';
import type { Env } from '../../../config/env';

/**
 * The logical downstream-service names the gateway can address. Adding
 * a new service is two lines: add the enum variant + the env→registry
 * mapping in `ServiceRegistry.buildEntries`. Phase-1 wires every Phase-1
 * backend; only `subscription` is required at boot.
 */
export type DownstreamServiceName =
  | 'identity'
  | 'household'
  | 'provider'
  | 'subscription'
  | 'booking'
  | 'search'
  | 'media'
  | 'notification'
  | 'audit'
  | 'payouts'
  | 'accounting'
  | 'concierge'
  | 'academy'
  | 'analytics'
  | 'ads'
  | 'content'
  | 'trust-safety';

interface ServiceEntry {
  readonly name: DownstreamServiceName;
  readonly baseUrl: string | null;
}

/**
 * The registry resolves each `DownstreamServiceName` to its base URL.
 * Returns `null` for services whose env var is unset — callers MUST
 * check before issuing the call so a deploy-time configuration gap
 * surfaces as a 503 (with a specific detail line) rather than a
 * crash. Today only `subscription` is required at boot per env.ts.
 *
 * The registry is the single source of truth for which services exist
 * + which are reachable. Readiness probe reads the same table to
 * report per-service status without hard-coupling the readiness
 * controller to env layout.
 */
@Injectable()
export class ServiceRegistry {
  private readonly entries: ReadonlyMap<DownstreamServiceName, ServiceEntry>;

  constructor(@Inject(ENV_TOKEN) env: Env) {
    this.entries = ServiceRegistry.buildEntries(env);
  }

  /**
   * Resolve a `DownstreamServiceName` to its base URL. Returns `null`
   * if the service's env var is unset.
   */
  baseUrl(name: DownstreamServiceName): string | null {
    return this.entries.get(name)?.baseUrl ?? null;
  }

  /**
   * Return every known service + its configured status. Used by the
   * readiness probe; never consumed in the request path.
   */
  list(): readonly ServiceEntry[] {
    return Array.from(this.entries.values());
  }

  private static buildEntries(env: Env): ReadonlyMap<DownstreamServiceName, ServiceEntry> {
    const pairs: readonly (readonly [DownstreamServiceName, string | undefined])[] = [
      ['identity', env.IDENTITY_SERVICE_BASE_URL],
      ['household', env.HOUSEHOLD_SERVICE_BASE_URL],
      ['provider', env.PROVIDER_SERVICE_BASE_URL],
      ['subscription', env.SUBSCRIPTION_SERVICE_BASE_URL],
      ['booking', env.BOOKING_SERVICE_BASE_URL],
      ['search', env.SEARCH_SERVICE_BASE_URL],
      ['media', env.MEDIA_SERVICE_BASE_URL],
      ['notification', env.NOTIFICATION_SERVICE_BASE_URL],
      ['audit', env.AUDIT_SERVICE_BASE_URL],
      ['payouts', env.PAYOUTS_SERVICE_BASE_URL],
      ['accounting', env.ACCOUNTING_SERVICE_BASE_URL],
      ['concierge', env.CONCIERGE_SERVICE_BASE_URL],
      ['academy', env.ACADEMY_SERVICE_BASE_URL],
      ['analytics', env.ANALYTICS_SERVICE_BASE_URL],
      ['ads', env.ADS_SERVICE_BASE_URL],
      ['content', env.CONTENT_SERVICE_BASE_URL],
      ['trust-safety', env.TRUST_SAFETY_SERVICE_BASE_URL],
    ];
    const map = new Map<DownstreamServiceName, ServiceEntry>();
    for (const [name, url] of pairs) {
      const baseUrl = typeof url === 'string' && url.length > 0 ? url.replace(/\/$/, '') : null;
      map.set(name, { name, baseUrl });
    }
    return map;
  }
}
