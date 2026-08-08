import { spawn } from 'node:child_process';

/**
 * Minimal child-process helpers for the E2E harness (TS-505).
 *
 * `shell: true` throughout. The commands the harness runs are package-manager
 * binaries (`pnpm exec prisma …`), which on Windows are `.cmd` shims that
 * `spawn` cannot execute directly. Nothing user-supplied reaches an argv here
 * — every argument is a literal in this package — and the one value that
 * could need quoting, the database URL, is passed through the environment
 * rather than argv precisely so no shell metacharacter (`?`, `&`) ever
 * reaches a command line.
 */

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Milliseconds before the child is killed and the promise rejects. */
  readonly timeoutMs?: number;
}

/** Run a command to completion, capturing its output. Never throws on a non-zero exit. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise, rejectPromise) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            child.kill('SIGKILL');
            rejectPromise(
              new Error(
                `Timed out after ${String(options.timeoutMs)}ms: ${command} ${args.join(' ')}\n${stderr}`,
              ),
            );
          }, options.timeoutMs);

    child.on('error', (error) => {
      if (timer !== undefined) clearTimeout(timer);
      rejectPromise(error);
    });

    child.on('close', (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/**
 * Run a command and throw a diagnosable error unless it exits 0.
 *
 * The thrown message carries the child's own stdout and stderr. A harness that
 * reports "migration failed" without the migration engine's output turns a
 * two-minute fix into an afternoon.
 */
export async function runOrThrow(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      [
        `Command failed (exit ${String(result.code)}): ${command} ${args.join(' ')}`,
        `  cwd: ${options.cwd}`,
        result.stdout.trim() === '' ? '' : `  stdout:\n${indent(result.stdout)}`,
        result.stderr.trim() === '' ? '' : `  stderr:\n${indent(result.stderr)}`,
      ]
        .filter((line) => line !== '')
        .join('\n'),
    );
  }
  return result;
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
