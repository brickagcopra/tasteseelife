import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { getSentryStatus } from '@taste-and-see/sentry/node';

import { OBSERVABILITY_SERVICE_NAME } from './tokens';

/**
 * Announces whether Sentry error reporting actually came up (TS-504-followup-2a).
 *
 * **Why this exists at all.** `createObservabilityBootstrap` resolves the
 * Sentry outcome as `main.ts`'s very first statement, long before any logger
 * exists, and every one of the 24 call sites discards its return value. So
 * without this the platform would compute `{ enabled: false, reason:
 * 'no_dsn' }` perfectly and tell nobody — a service with no error reporting
 * would look exactly like one with error reporting, which is the failure mode
 * TS-306-followup-1c (a meter that had reported nothing since the public blog
 * shipped) and TS-306-followup-1d (six services whose shared-package
 * instruments were never bootstrapped) were both about.
 *
 * **Why the level differs by environment.** In development an absent
 * `SENTRY_DSN` is the expected state and a WARN on every boot is noise that
 * trains people to ignore warnings. Outside development it is an outage: the
 * service is running and its errors are going nowhere. Same event, genuinely
 * different severity.
 */
@Injectable()
export class SentryStatusReporter implements OnApplicationBootstrap {
  private readonly logger = new Logger(SentryStatusReporter.name);

  constructor(@Inject(OBSERVABILITY_SERVICE_NAME) private readonly serviceName: string) {}

  onApplicationBootstrap(): void {
    const status = getSentryStatus();

    if (status === undefined) {
      // The bootstrap shim was not imported, or was imported after this
      // module loaded. Either way the first-line contract in `main.ts` is
      // broken and traces/metrics are likely missing too.
      this.logger.warn(
        { service: this.serviceName },
        'sentry status unknown — observability bootstrap did not run before the Nest app',
      );
      return;
    }

    if (status.enabled) {
      this.logger.log(
        { service: this.serviceName, release: status.release },
        'sentry error reporting enabled',
      );
      return;
    }

    const detail = { service: this.serviceName, reason: status.reason };
    if (isDevelopment()) {
      this.logger.log(detail, 'sentry error reporting off');
    } else {
      this.logger.warn(
        detail,
        'sentry error reporting OFF — unhandled errors in this service are not being reported anywhere',
      );
    }
  }
}

function isDevelopment(): boolean {
  const env = process.env['NODE_ENV'];
  return env === undefined || env === '' || env === 'development' || env === 'test';
}
