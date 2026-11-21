// Runs the worker pool on boat.dev: one always-on machine per worker, the
// worker under systemd, the code deployed from a commit.
//
//   node scripts/boat-workers.ts up              create or update every worker whose secret is set
//   node scripts/boat-workers.ts status          each machine's state, service, and last log line
//   node scripts/boat-workers.ts logs <profile>  the last 100 log lines of one worker
//
// Settings come from .env (see .env.example), plus .env.mcp when MCP servers need secrets.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Harness } from "../lib/config.ts";

const API = "https://boat.dev/api/v1";
const NAME_PREFIX = "robdog-";
const HOME = "/home/user";
const DEPLOY_PATHS = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "lib", "worker", "skills"];
const AGENT_BROWSER_VERSION = "0.43.0";
const PNPM = "pnpm@12.11.2";

export interface PoolWorker {
  readonly profile: string;
  readonly harness: Harness;
  /** The .env variable holding this worker's model credential. The worker is skipped while it is unset. */
  readonly secret: string;
  /** boat machine size. A Next.js dev build of a large app needs more than small's 4 GB. */
  readonly type: "small" | "default" | "large";
}

/**
 * The pool. Codex is left out: its ChatGPT login has to be made on the
 * machine itself (`boat ssh robdog-codex-1 -- codex login --device-auth`).
 */
export const POOL: readonly PoolWorker[] = [
  { profile: "claude-1", harness: "claude", secret: "CLAUDE_TOKEN_1", type: "default" },
  { profile: "claude-2", harness: "claude", secret: "CLAUDE_TOKEN_2", type: "default" },
  { profile: "claude-3", harness: "claude", secret: "CLAUDE_TOKEN_3", type: "default" },
  { profile: "opencode-1", harness: "opencode", secret: "AI_GATEWAY_API_KEY", type: "default" },
];

/** What every worker needs, from .env. */
const SHARED = ["BOARD_TOKEN", "VERCEL_ORG_ID", "ROBDOG_BOARD_FROM", "GH_TOKEN"] as const;
const OPTIONAL = ["HARNESS_GH_TOKEN", "ROBDOG_GIT_NAME", "ROBDOG_GIT_EMAIL", "JOB_TIMEOUT_MINUTES"] as const;

/** The worker's environment on its machine. */
export function workerEnv(
  worker: PoolWorker,
  env: Readonly<Record<string, string | undefined>>,
  mcpSecrets: Readonly<Record<string, string>>,
  version: string,
): Record<string, string> {
  const missing = SHARED.filter((name) => !env[name]);
  if (missing.length > 0) throw new Error(`set ${missing.join(", ")} in .env`);
  const out: Record<string, string> = { ...mcpSecrets };
  for (const name of [...SHARED, ...OPTIONAL]) {
    const value = env[name];
    if (value) out[name] = value;
  }
  const credential = env[worker.secret];
  if (!credential) throw new Error(`set ${worker.secret} in .env for ${worker.profile}`);
  if (worker.harness === "claude") out.CLAUDE_CODE_OAUTH_TOKEN = credential;
  if (worker.harness === "opencode") out.AI_GATEWAY_API_KEY = credential;
  return {
    ...out,
    BOARD_PROFILE: worker.profile,
    WORKER_HARNESS: worker.harness,
    WORK_DIR: `${HOME}/work`,
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable",
    ROBDOG_VERSION: version,
  };
}

/** A systemd EnvironmentFile: one KEY="value" per line. */
export function renderEnvFile(env: Readonly<Record<string, string>>): string {
  return `${Object.entries(env)
    .map(([key, value]) => {
      if (/[\n\r]/.test(value)) throw new Error(`${key} must be one line`);
      return `${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    })
    .join("\n")}\n`;
}

export function renderUnit(node: string, path: string): string {
  return [
    "[Unit]",
    "Description=robdog worker",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "User=user",
    `WorkingDirectory=${HOME}/robdog`,
    `EnvironmentFile=${HOME}/.robdog/worker.env`,
    `Environment=HOME=${HOME}`,
    `Environment=PATH=${path}`,
    `ExecStart=${node} worker/main.ts`,
    "Restart=always",
    "RestartSec=10",
    // The worker releases its job on SIGTERM; give the coding CLI time to stop.
    "KillSignal=SIGTERM",
    "TimeoutStopSec=30",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "",
  ].join("\n");
}

/** Reads a dotenv file without interpreting it beyond KEY=value lines. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = match;
    if (key && raw) out[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

interface Sandbox {
  readonly id: string;
  readonly name?: string;
  readonly state: string;
  readonly type?: string;
}

class Boat {
  readonly #key: string;
  constructor(key: string) {
    this.#key = key;
  }

  async call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as T & { ok?: boolean; code?: string; message?: string };
    if (!response.ok || data.ok === false) {
      throw new Error(
        `boat ${method} ${path}: ${response.status} ${data.code ?? ""} ${data.message ?? ""}`.trim(),
      );
    }
    return data;
  }

  async list(): Promise<Sandbox[]> {
    const { sandboxes } = await this.call<{ sandboxes: Sandbox[] }>("GET", "/sandboxes");
    return sandboxes;
  }

  async get(id: string): Promise<Sandbox> {
    return (await this.call<{ sandbox: Sandbox }>("GET", `/sandboxes/${id}`)).sandbox;
  }

  async create(name: string, type: string): Promise<Sandbox> {
    // No auto-stop: the worker is a service. noEnv: the machine carries only the credentials this script writes.
    const body = { type, name, ttlSeconds: null, noEnv: true };
    return (
      await this.call<{ sandbox: Sandbox }>("POST", "/sandboxes", body, {
        "idempotency-key": `create-${name}`,
      })
    ).sandbox;
  }

  /** boat's stop is asynchronous; a resume only works once the stop has finished. */
  async waitUntilState(id: string, wanted: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { state } = await this.get(id);
      if (state === wanted) return;
      if (state === "error") throw new Error(`machine ${id} is in state error`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(`machine ${id} never reached ${wanted}`);
  }

  async resume(id: string, type?: string): Promise<void> {
    await this.call("POST", `/sandboxes/${id}/resume`, { ttlSeconds: null, ...(type ? { type } : {}) });
  }

  async stop(id: string): Promise<void> {
    await this.call("POST", `/sandboxes/${id}/stop`, {});
  }

  async waitUntilUp(id: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const { state } = await this.get(id);
      if (["ready", "idle", "running"].includes(state)) return;
      if (state === "error") throw new Error(`machine ${id} is in state error`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new Error(`machine ${id} did not come up`);
  }

  /** Runs a command and returns its stdout; throws on a non-zero exit. */
  async run(id: string, command: string, timeoutSeconds = 120): Promise<string> {
    const result = await this.call<{ exitCode: number; stdout?: string; stderr?: string }>(
      "POST",
      `/sandboxes/${id}/commands`,
      { command, timeoutSeconds },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `"${command.slice(0, 80)}" exited ${result.exitCode}: ${(result.stderr || result.stdout || "").slice(-1_500)}`,
      );
    }
    return (result.stdout ?? "").trim();
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    await this.call("PUT", `/sandboxes/${id}/files`, { path, content, encoding: "utf8" });
  }

  async upload(id: string, path: string, bytes: Uint8Array): Promise<void> {
    const { url } = await this.call<{ url: string }>("POST", `/sandboxes/${id}/files/upload-url`, { path });
    const response = await fetch(url, { method: "PUT", body: new Uint8Array(bytes) });
    if (!response.ok) throw new Error(`upload of ${path} failed: HTTP ${response.status}`);
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

async function machineFor(boat: Boat, worker: PoolWorker, existing: Sandbox[]): Promise<Sandbox> {
  const profile = worker.profile;
  const name = `${NAME_PREFIX}${profile}`;
  const found = existing.find((sandbox) => sandbox.name === name);
  if (!found) {
    log(profile, `creating a ${worker.type} machine`);
    const created = await boat.create(name, worker.type);
    await boat.waitUntilUp(created.id);
    return created;
  }
  const resize = found.type !== undefined && found.type !== worker.type;
  if (resize && !["archiving", "archived"].includes(found.state)) {
    // boat changes a machine's size only while it is stopped. The worker hands back any job it holds.
    log(profile, `stopping ${found.id} to resize it from ${found.type} to ${worker.type}`);
    await boat.stop(found.id);
  }
  if (resize || ["archiving", "archived"].includes(found.state)) {
    log(profile, `resuming ${found.id}${resize ? ` as ${worker.type}` : ""}`);
    await boat.waitUntilState(found.id, "archived");
    await boat.resume(found.id, resize ? worker.type : undefined);
  }
  await boat.waitUntilUp(found.id);
  return found;
}

function log(profile: string, message: string): void {
  process.stdout.write(`${profile.padEnd(11)} ${message}\n`);
}

async function up(boat: Boat, env: Record<string, string | undefined>): Promise<void> {
  const repoRoot = join(import.meta.dirname, "..");
  const version = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain", "--", ...DEPLOY_PATHS], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (dirty.trim())
    process.stdout.write(`warning: uncommitted changes are not deployed; deploying ${version}\n`);
  const archive = execFileSync("git", ["archive", "--format=tar.gz", "HEAD", ...DEPLOY_PATHS], {
    cwd: repoRoot,
  });
  const mcpSecrets = readEnvFile(join(repoRoot, ".env.mcp"));

  const workers = POOL.filter((worker) => {
    if (env[worker.secret]) return true;
    log(worker.profile, `skipped: ${worker.secret} is not set`);
    return false;
  });
  const existing = await boat.list();

  await Promise.all(
    workers.map(async (worker) => {
      const p = worker.profile;
      const envFile = renderEnvFile(workerEnv(worker, env, mcpSecrets, version));
      const machine = await machineFor(boat, worker, existing);
      log(p, `deploying ${version} to ${machine.id}`);
      await boat.upload(machine.id, "robdog.tgz", archive);
      await boat.run(
        machine.id,
        [
          "set -e",
          "rm -rf ~/robdog.next && mkdir -p ~/robdog.next ~/work ~/.robdog && chmod 700 ~/.robdog",
          "tar xzf ~/robdog.tgz -C ~/robdog.next",
          `cd ~/robdog.next && npx -y ${PNPM} install --prod --frozen-lockfile --ignore-scripts > /dev/null`,
          `npm ls -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null 2>&1 || npm i -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null`,
          "rm -rf ~/robdog && mv ~/robdog.next ~/robdog && rm ~/robdog.tgz",
        ].join("\n"),
        600,
      );
      await boat.writeFile(machine.id, ".robdog/worker.env", envFile);
      const node = await boat.run(machine.id, "command -v node");
      const path = await boat.run(machine.id, 'printf %s "$PATH"');
      await boat.writeFile(machine.id, ".robdog/robdog-worker.service", renderUnit(node, path));
      await boat.run(
        machine.id,
        [
          "set -e",
          "chmod 600 ~/.robdog/worker.env",
          "sudo install -m 644 ~/.robdog/robdog-worker.service /etc/systemd/system/robdog-worker.service",
          "sudo systemctl daemon-reload",
          "sudo systemctl enable robdog-worker > /dev/null 2>&1",
          "sudo systemctl restart robdog-worker",
        ].join("\n"),
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const logs = await boat.run(machine.id, "sudo journalctl -u robdog-worker -n 30 --no-pager -o cat");
        if (logs.includes('"worker.ready"')) {
          log(p, `ready on ${machine.id}`);
          return;
        }
        if (logs.includes('"config.invalid"') || logs.includes('"worker.crashed"')) {
          throw new Error(`${p} failed to start:\n${logs.split("\n").slice(-8).join("\n")}`);
        }
      }
      throw new Error(
        `${p} did not report ready within a minute; see: node scripts/boat-workers.ts logs ${p}`,
      );
    }),
  );
}

async function status(boat: Boat): Promise<void> {
  const machines = (await boat.list()).filter((sandbox) => sandbox.name?.startsWith(NAME_PREFIX));
  if (machines.length === 0) process.stdout.write("no robdog machines\n");
  for (const machine of machines) {
    const profile = machine.name?.slice(NAME_PREFIX.length) ?? machine.id;
    if (!["ready", "idle", "running"].includes(machine.state)) {
      log(profile, `${machine.id} ${machine.state}`);
      continue;
    }
    const service = await boat
      .run(machine.id, "systemctl is-active robdog-worker || true")
      .catch((error: unknown) => String(error));
    const last = await boat
      .run(machine.id, "sudo journalctl -u robdog-worker -n 1 --no-pager -o cat || true")
      .catch(() => "");
    log(profile, `${machine.id} ${machine.state} service=${service} ${last.slice(0, 160)}`);
  }
}

async function logs(boat: Boat, profile: string | undefined): Promise<void> {
  if (!profile) throw new Error("usage: node scripts/boat-workers.ts logs <profile>");
  const machine = (await boat.list()).find((sandbox) => sandbox.name === `${NAME_PREFIX}${profile}`);
  if (!machine) throw new Error(`no machine for ${profile}`);
  process.stdout.write(
    `${await boat.run(machine.id, "sudo journalctl -u robdog-worker -n 100 --no-pager -o cat")}\n`,
  );
}

async function main(): Promise<void> {
  const env: Record<string, string | undefined> = {
    ...readEnvFile(join(import.meta.dirname, "..", ".env")),
    ...process.env,
  };
  const key = env.BOAT_API_KEY;
  if (!key) throw new Error("set BOAT_API_KEY in .env");
  const boat = new Boat(key);
  const [command, argument] = process.argv.slice(2);
  if (command === "up") await up(boat, env);
  else if (command === "status") await status(boat);
  else if (command === "logs") await logs(boat, argument);
  else throw new Error("usage: node scripts/boat-workers.ts up | status | logs <profile>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
