import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';

import { FLEET, serviceDir, type FleetService } from './fleet';
import { REPO_ROOT } from './repo-env';

/**
 * Fleet process lifecycle (TS-505).
 *
 * **Why the harness owns this instead of Playwright's `webServer`.** Playwright
 * starts `webServer` entries as a *plugin*, and plugin setup runs before
 * `globalSetup`. The E2E database must be dropped, recreated and migrated
 * before a single service opens a connection pool against it, so the ordering
 * Playwright offers is exactly backwards for this fleet. Owning the processes
 * also buys two things the built-in cannot: per-service log files (a failing
 * spec is usually explained by one downstream's stderr, not by the gateway's
 * 502), and a readiness gate that distinguishes "the process is listening"
 * from "the process can reach its database".
 *
 * **Services are spawned as direct `node` children, never through a shell.**
 * A shell in between makes the child unkillable by pid on Windows — the signal
 * reaches `cmd.exe` and the service keeps the port, which turns one flaky run
 * into every subsequent run failing to bind.
 */

/** Lines of each service's output kept in memory to attach to a start-up failure. */
const RETAINED_LOG_LINES = 60;

const LOG_DIR = resolve(REPO_ROOT, 'apps', 'e2e', 'test-results', 'fleet');

export interface StartedService {
  readonly service: FleetService;
  readonly child: ChildProcess;
  readonly logPath: string;
  /** Most recent output, for error messages. */
  readonly tail: () => string;
}

export interface StartedFleet {
  readonly services: readonly StartedService[];
  readonly stop: () => Promise<void>;
}

/**
 * Start every fleet member in declaration order and wait for each to report
 * healthy before starting the next.
 *
 * Sequential, not parallel. The fleet is small, the services are independent,
 * and a parallel start interleaves the boot logs of a dozen processes into
 * something no one can read. Sequential start also means the first failure
 * names one service.
 */
export async function startFleet(
  envFor: (service: FleetService) => NodeJS.ProcessEnv,
  options: { readonly readinessTimeoutMs: number },
): Promise<StartedFleet> {
  mkdirSync(LOG_DIR, { recursive: true });

  const started: StartedService[] = [];

  const stop = async (): Promise<void> => {
    // Reverse order: the gateway stops before the services it proxies, so a
    // shutting-down fleet never logs a wave of connection-refused errors.
    for (const entry of [...started].reverse()) {
      await stopService(entry);
    }
    started.length = 0;
  };

  for (const service of FLEET) {
    let entry: StartedService;
    try {
      entry = spawnService(service, envFor(service));
    } catch (error) {
      await stop();
      throw error;
    }
    started.push(entry);

    try {
      await waitForHealthy(entry, options.readinessTimeoutMs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const tail = entry.tail();
      await stop();
      throw new Error(
        `${service.dir} did not become healthy on port ${String(service.port)}.\n` +
          `  ${detail}\n` +
          `  log: ${entry.logPath}\n` +
          (tail === '' ? '' : `  last output:\n${indent(tail)}`),
      );
    }
  }

  return { services: started, stop };
}

function spawnService(service: FleetService, env: NodeJS.ProcessEnv): StartedService {
  const cwd = serviceDir(service);
  const logPath = resolve(LOG_DIR, `${service.dir}.log`);
  const logStream: WriteStream = createWriteStream(logPath, { flags: 'w' });

  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const retained: string[] = [];
  const capture = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    logStream.write(text);
    for (const line of text.split(/\r?\n/)) {
      if (line !== '') {
        retained.push(line);
      }
    }
    if (retained.length > RETAINED_LOG_LINES) {
      retained.splice(0, retained.length - RETAINED_LOG_LINES);
    }
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.once('close', () => {
    logStream.end();
  });

  return { service, child, logPath, tail: () => retained.join('\n') };
}

/**
 * Poll `/healthz` until the process answers, then require `/readyz`.
 *
 * The two probes answer different questions and the suite needs both: a
 * service that is listening but cannot reach Postgres produces 500s that read
 * like application bugs. Waiting for readiness moves that failure to fleet
 * start-up, where the message says which service and why.
 */
async function waitForHealthy(entry: StartedService, timeoutMs: number): Promise<void> {
  const base = `http://127.0.0.1:${String(entry.service.port)}`;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response yet';

  for (;;) {
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error(
        `process exited during start-up (code ${String(entry.child.exitCode)}, signal ${String(entry.child.signalCode)})`,
      );
    }

    try {
      const health = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(2_000) });
      if (health.ok) {
        const ready = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(5_000) });
        if (ready.ok) {
          return;
        }
        lastError = `/readyz answered ${String(ready.status)}: ${(await ready.text()).slice(0, 500)}`;
      } else {
        lastError = `/healthz answered ${String(health.status)}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (Date.now() >= deadline) {
      throw new Error(`gave up after ${String(timeoutMs)}ms — last probe: ${lastError}`);
    }
    await delay(250);
  }
}

async function stopService(entry: StartedService): Promise<void> {
  if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
    return;
  }

  const exited = new Promise<void>((resolvePromise) => {
    entry.child.once('close', () => {
      resolvePromise();
    });
  });

  entry.child.kill('SIGTERM');

  // NestJS shutdown hooks drain the HTTP server and close pools; give them a
  // bounded window, then take the port back by force. A lingering process is
  // worse than an ungraceful exit — the next run cannot bind.
  const timer = setTimeout(() => {
    entry.child.kill('SIGKILL');
  }, 10_000);

  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, ms);
  });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
