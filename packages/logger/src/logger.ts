import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

import type { LogContext } from './context';
import type { LogLevel } from './levels';
import { DEFAULT_REDACT_PATHS, REDACTION_CENSOR } from './redaction';

export interface CreateLoggerOptions {
  /** Bounded-context service name (e.g. `service-identity`). Required. */
  service: string;
  /** Deployment environment label (`dev` / `staging` / `prod`). Defaults to `NODE_ENV` then `development`. */
  env?: string;
  /** Build / image version tag. Optional, but strongly recommended in production. */
  version?: string;
  /** Pino level. Defaults to `LOG_LEVEL` env then `info`. */
  level?: LogLevel;
  /** Override the redaction path list. Prefer extending `DEFAULT_REDACT_PATHS` over replacing it. */
  redactPaths?: readonly string[];
  /** Extra static fields baked into every log line for this service instance. */
  base?: Record<string, unknown>;
  /** Destination stream override — used by tests and by services routing to syslog/file. */
  destination?: DestinationStream;
}

export type ServiceLogger = Logger;

/**
 * Build a pino logger pre-configured for the Taste & See platform:
 * structured JSON, ISO timestamps, level emitted as label, and redaction
 * applied at the logger layer per CLAUDE.md §10. Never call `pino()`
 * directly from a service — always go through this factory so redaction is
 * not accidentally bypassed.
 */
export function createLogger(options: CreateLoggerOptions): ServiceLogger {
  const env = options.env ?? process.env['NODE_ENV'] ?? 'development';
  const level = options.level ?? coerceLogLevel(process.env['LOG_LEVEL']) ?? 'info';
  const redactPaths = options.redactPaths ?? DEFAULT_REDACT_PATHS;

  const bindings: Record<string, unknown> = {
    service: options.service,
    env,
    ...(options.base ?? {}),
  };
  if (options.version !== undefined) {
    bindings['version'] = options.version;
  }

  const pinoOptions: LoggerOptions = {
    level,
    base: bindings,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    redact: {
      paths: [...redactPaths],
      censor: REDACTION_CENSOR,
      remove: false,
    },
  };

  return options.destination !== undefined
    ? pino(pinoOptions, options.destination)
    : pino(pinoOptions);
}

/**
 * Attach correlation fields (CLAUDE.md §10) to a logger via a child binding.
 * Only non-undefined fields are propagated so log lines stay tight.
 *
 * Use this at the request boundary (e.g. NestJS interceptor / `AsyncLocalStorage`
 * scope) so every downstream log line carries the same trace + actor + tenant
 * context without per-call boilerplate.
 */
export function withContext(logger: ServiceLogger, context: LogContext): ServiceLogger {
  const bindings: Record<string, string> = {};
  if (context.traceId !== undefined) bindings['traceId'] = context.traceId;
  if (context.spanId !== undefined) bindings['spanId'] = context.spanId;
  if (context.requestId !== undefined) bindings['requestId'] = context.requestId;
  if (context.actorId !== undefined) bindings['actorId'] = context.actorId;
  if (context.tenantScope !== undefined) bindings['tenantScope'] = context.tenantScope;
  return logger.child(bindings);
}

function coerceLogLevel(value: string | undefined): LogLevel | undefined {
  if (value === undefined) return undefined;
  switch (value) {
    case 'fatal':
    case 'error':
    case 'warn':
    case 'info':
    case 'debug':
    case 'trace':
    case 'silent':
      return value;
    default:
      return undefined;
  }
}
