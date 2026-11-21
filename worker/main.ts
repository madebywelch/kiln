// A kiln worker: runs one job on its own boat machine. The agent launches the
// machine with the job's ID and this worker's settings; the worker claims that
// job, runs the coding CLI on it, settles it, and exits. The agent then deletes
// the machine.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Board, BoardError, board, type ClaimedTask } from "@vercel/board";
import { z } from "zod";
import { HARNESSES } from "../lib/config.ts";
import { WORKER_SETTINGS_PATH } from "../lib/machines.ts";
import { McpServerSchema } from "../lib/mcp.ts";
import { type Exec, exec, run } from "./exec.ts";
import { CLAIM_LOST, harnessEnv, type Logger, type OpenPullRequest, runJob, SHUTDOWN } from "./job.ts";
import { installSkills, skillTargets } from "./skills.ts";

const Subscriptions = z.array(z.object({ id: z.string(), token: z.string(), record: z.string() }));

const Config = z
  .object({
    BOARD_PROFILE: z
      .string()
      .regex(/^[a-zA-Z][a-zA-Z0-9-]{0,31}$/, "a letter, then up to 31 letters, digits, or hyphens"),
    WORKER_HARNESS: z.enum(HARNESSES),
    /** git and gh authenticate with it: a fine-grained token with contents and pull requests read/write on the repos. */
    GH_TOKEN: z.string().min(1, "set GH_TOKEN so the worker can clone, push, and open pull requests"),
    /** Optional read-only GitHub token for the coding CLI itself (CI logs, issues). It never gets GH_TOKEN. */
    HARNESS_GH_TOKEN: z.string().optional(),
    /** The one job this worker runs. */
    KILN_JOB_ID: z.string().min(1, "set KILN_JOB_ID to the job this worker runs"),
    /** The repo's MCP servers, as JSON from the agent. */
    KILN_MCP_SERVERS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value) return {};
        let json: unknown;
        try {
          json = JSON.parse(value);
        } catch {
          json = undefined;
        }
        const parsed = z.record(z.string(), McpServerSchema).safeParse(json);
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: "custom", message: "not a map of MCP servers" });
        return z.NEVER;
      }),
    /** For a Claude job, the subscriptions it may use, in the order to try them: JSON from the agent. */
    KILN_SUBSCRIPTIONS: z
      .string()
      .optional()
      .transform((value, ctx) => {
        if (!value) return [];
        let json: unknown;
        try {
          json = JSON.parse(value);
        } catch {
          json = undefined;
        }
        const parsed = Subscriptions.safeParse(json);
        if (parsed.success) return parsed.data;
        ctx.addIssue({ code: "custom", message: "not a list of {id, token, record}" });
        return z.NEVER;
      }),
    WORK_DIR: z.string().default("/work"),
    JOB_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(180),
    /** Commit identity. Not GIT_AUTHOR_*: git reads those itself, and an empty one breaks every commit. */
    KILN_GIT_NAME: z.string().optional(),
    KILN_GIT_EMAIL: z.string().optional(),
    /** Claude Code's subscription login, from `claude setup-token`. */
    CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
    /** OpenCode's AI Gateway key, from the Vercel dashboard (AI Gateway, API keys). */
    AI_GATEWAY_API_KEY: z.string().optional(),
  })
  .refine((config) => config.WORKER_HARNESS !== "claude" || config.CLAUDE_CODE_OAUTH_TOKEN, {
    path: ["CLAUDE_CODE_OAUTH_TOKEN"],
    message: "a claude worker needs CLAUDE_CODE_OAUTH_TOKEN: run `claude setup-token` with its subscription",
  })
  .refine((config) => config.WORKER_HARNESS !== "opencode" || config.AI_GATEWAY_API_KEY, {
    path: ["AI_GATEWAY_API_KEY"],
    message: "an opencode worker needs AI_GATEWAY_API_KEY: create one under AI Gateway, API keys, in Vercel",
  });
type Config = z.infer<typeof Config>;

const LEASE_SECONDS = 300; // Vercel's board caps a lease at 5 minutes

const log: Logger = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};

export function ghPullRequest(execFn: Exec): OpenPullRequest {
  return async ({ cwd, github, base, head, title, body }) => {
    const existing = await execFn(
      "gh",
      ["pr", "view", head, "--repo", github, "--json", "url", "--jq", ".url"],
      {
        cwd,
      },
    );
    if (existing.code === 0 && existing.stdout.trim()) return existing.stdout.trim();
    const created = await run(
      execFn,
      "gh",
      [
        "pr",
        "create",
        "--draft",
        "--repo",
        github,
        "--base",
        base,
        "--head",
        head,
        "--title",
        title,
        "--body-file",
        "-",
      ],
      { cwd, input: body },
    );
    return created.split("\n").at(-1) ?? created;
  };
}

/** Renews the claim at a third of its lease; aborts the job if the board says the claim is over. */
function keepAlive(claim: ClaimedTask, job: AbortController): () => void {
  const timer = setInterval(
    () => {
      claim.renew(LEASE_SECONDS).catch((error: unknown) => {
        if (error instanceof BoardError && error.code === "claim_lost") job.abort(CLAIM_LOST);
        else log("claim.renew_failed", { task: claim.task.id, error: String(error) });
      });
    },
    (LEASE_SECONDS * 1000) / 3,
  );
  return () => clearInterval(timer);
}

/** Claims the worker's job and runs it. Returns once the job is settled, handed back, or someone else's. */
async function work(config: Config, team: Board, shutdown: AbortSignal, guidance: string): Promise<void> {
  log("worker.ready", {
    profile: config.BOARD_PROFILE,
    harness: config.WORKER_HARNESS,
    task: config.KILN_JOB_ID,
  });
  let claim: ClaimedTask;
  try {
    claim = await team.tasks.claim(config.KILN_JOB_ID, { lease: LEASE_SECONDS });
  } catch (error) {
    // Another machine has it, or it was canceled or settled before this one came up: nothing to do.
    if (error instanceof BoardError) {
      log("job.unavailable", { task: config.KILN_JOB_ID, code: error.code, error: error.message });
      return;
    }
    throw error;
  }

  const job = new AbortController();
  const onShutdown = () => job.abort(SHUTDOWN);
  shutdown.addEventListener("abort", onShutdown, { once: true });
  const stop = keepAlive(claim, job);
  log("job.claimed", { task: claim.task.id });
  try {
    await runJob({
      board: team,
      claim,
      profile: config.BOARD_PROFILE,
      workDir: config.WORK_DIR,
      exec,
      cloneUrl: (github) => `https://github.com/${github}.git`,
      openPullRequest: ghPullRequest(exec),
      timeoutMs: config.JOB_TIMEOUT_MINUTES * 60_000,
      harnessEnv: harnessEnv(process.env, config.HARNESS_GH_TOKEN),
      guidance,
      signal: job.signal,
      log,
      subscriptions: config.KILN_SUBSCRIPTIONS,
      mcpServers: config.KILN_MCP_SERVERS,
      gitIdentity:
        config.KILN_GIT_NAME && config.KILN_GIT_EMAIL
          ? { name: config.KILN_GIT_NAME, email: config.KILN_GIT_EMAIL }
          : undefined,
    });
  } finally {
    stop();
    shutdown.removeEventListener("abort", onShutdown);
  }
}

/**
 * Moves the settings file the agent wrote into the environment, overriding what is there, and deletes
 * it, so the coding CLI doesn't find the worker's credentials lying in the home directory.
 */
export function loadSettingsFile(path: string, env: NodeJS.ProcessEnv): boolean {
  if (!existsSync(path)) return false;
  const settings = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(settings)) if (typeof value === "string") env[key] = value;
  rmSync(path);
  return true;
}

/** Reads the worker's settings. An empty value means unset, as an env file writes an unset optional one. */
export function parseConfig(env: NodeJS.ProcessEnv) {
  return Config.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")));
}

async function main(): Promise<void> {
  if (loadSettingsFile(join(homedir(), WORKER_SETTINGS_PATH), process.env)) log("settings.loaded");
  const parsed = parseConfig(process.env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues)
      log("config.invalid", { field: issue.path.join("."), error: issue.message });
    process.exit(2);
  }
  const config = parsed.data;
  if (config.WORKER_HARNESS === "codex" && !existsSync(join(homedir(), ".codex", "auth.json"))) {
    log("config.invalid", {
      field: "codex login",
      error: "log in once on this machine: codex login --device-auth",
    });
    process.exit(2);
  }
  // git over https authenticates through gh, which reads GH_TOKEN.
  await run(exec, "gh", ["auth", "setup-git"]);
  const skills = await installSkills(
    fileURLToPath(new URL("../skills/workers", import.meta.url)),
    skillTargets(homedir()),
  );
  log("skills.installed", {
    installed: skills.installed.length,
    removed: skills.removed.length,
    kept: skills.kept.length,
  });
  const guidance = (await readFile(new URL("./instructions.md", import.meta.url), "utf8"))
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
  const team = board().as(config.BOARD_PROFILE);

  const shutdown = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      log("worker.stopping", { signal });
      shutdown.abort();
    });
  }
  await work(config, team, shutdown.signal, guidance);
  log("worker.done", { task: config.KILN_JOB_ID });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log("worker.crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exit(1);
  });
}
