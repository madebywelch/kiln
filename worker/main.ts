// A robdog worker: one coding-CLI subscription that claims jobs from Vercel
// Board, one at a time, until it is told to stop. Run one per subscription.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Board, BoardError, board, type ClaimedTask } from "@vercel/board";
import { z } from "zod";
import { HARNESSES } from "../lib/config.ts";
import { JOBS_CHANNEL } from "../lib/jobs.ts";
import { type Exec, exec, run } from "./exec.ts";
import { CLAIM_LOST, harnessEnv, type Logger, type OpenPullRequest, runJob, SHUTDOWN } from "./job.ts";
import { installSkills, skillTargets } from "./skills.ts";

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
    /** Board actor IDs whose jobs this worker takes, comma-separated: robdog's deployment. Empty: only its own login's. */
    ROBDOG_BOARD_FROM: z.string().default(""),
    WORK_DIR: z.string().default("/work"),
    JOB_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(180),
    /** Commit identity. Not GIT_AUTHOR_*: git reads those itself, and an empty one breaks every commit. */
    ROBDOG_GIT_NAME: z.string().optional(),
    ROBDOG_GIT_EMAIL: z.string().optional(),
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
const CLAIM_WAIT_SECONDS = 60;

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

async function work(config: Config, team: Board, shutdown: AbortSignal, guidance: string): Promise<void> {
  const from = config.ROBDOG_BOARD_FROM.split(",")
    .map((actor) => actor.trim())
    .filter(Boolean);
  const label = { robdog: "job", harness: config.WORKER_HARNESS };
  log("worker.ready", { profile: config.BOARD_PROFILE, harness: config.WORKER_HARNESS, from });

  while (!shutdown.aborted) {
    let claim: ClaimedTask | null;
    try {
      claim = await team.tasks.claim(
        {
          channel: JOBS_CHANNEL,
          label,
          wait: CLAIM_WAIT_SECONDS,
          lease: LEASE_SECONDS,
          ...(from.length ? { from } : {}),
        },
        { signal: shutdown },
      );
    } catch (error) {
      if (shutdown.aborted) break;
      log("claim.failed", { error: String(error) });
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      continue;
    }
    if (!claim) continue;

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
        gitIdentity:
          config.ROBDOG_GIT_NAME && config.ROBDOG_GIT_EMAIL
            ? { name: config.ROBDOG_GIT_NAME, email: config.ROBDOG_GIT_EMAIL }
            : undefined,
      });
    } finally {
      stop();
      shutdown.removeEventListener("abort", onShutdown);
    }
  }
  log("worker.stopped", { profile: config.BOARD_PROFILE });
}

/** Reads the worker's settings. An empty value means unset, as an env file writes an unset optional one. */
export function parseConfig(env: NodeJS.ProcessEnv) {
  return Config.safeParse(Object.fromEntries(Object.entries(env).filter(([, value]) => value !== "")));
}

async function main(): Promise<void> {
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
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    log("worker.crashed", { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    process.exit(1);
  });
}
