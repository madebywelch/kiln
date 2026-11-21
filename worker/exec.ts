import { spawn } from "node:child_process";

export interface ExecOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Receives every chunk of stdout and stderr as it arrives, e.g. to write a log file. */
  readonly onOutput?: (chunk: string) => void;
}

export interface ExecResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export type Exec = (command: string, args: readonly string[], options?: ExecOptions) => Promise<ExecResult>;

// A harness can print a lot. Keep the tail in memory; the full stream goes to onOutput.
const MAX_CAPTURE = 2 * 1024 * 1024;
const KILL_GRACE_MS = 10_000;

function append(buffer: string, chunk: string): string {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

/**
 * Runs a command to completion. It never rejects for a non-zero exit, a
 * timeout, or an abort: those are in the result. It rejects only when the
 * command cannot start. Timeouts and aborts kill the whole process group, so
 * a harness's own children die with it.
 */
export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    const kill = () => {
      if (child.exitCode !== null || child.pid === undefined) return;
      const pid = child.pid;
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
      killTimer.unref();
    };

    const timeout =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            kill();
          }, options.timeoutMs);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
      options.onOutput?.(chunk);
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
      options.onOutput?.(chunk);
    });
    child.stdin.on("error", () => {}); // a command that exits without reading stdin closes the pipe early
    child.stdin.end(options.input ?? "");

    child.on("error", (error) => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr, timedOut, aborted });
    });
  });

/** Runs a command that must succeed, returning trimmed stdout. */
export async function run(
  execFn: Exec,
  command: string,
  args: readonly string[],
  options?: ExecOptions,
): Promise<string> {
  const result = await execFn(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim().split("\n").slice(-5).join("\n");
    throw new Error(`${command} ${args[0] ?? ""} exited ${result.code}: ${detail}`);
  }
  return result.stdout.trim();
}
