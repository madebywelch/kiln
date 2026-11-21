// One fresh boat machine per job. The agent launches a machine when it starts a
// job and, every minute, reconciles: a machine for each ready job, within each
// harness's limit, and no machine for a job that is over. A machine lives from
// its job's start to its settle, plus at most a minute; idle, kiln costs nothing.

import type { Board, MessageView } from "@vercel/board";
import { type Boat, BoatError, type Machine } from "./boat.ts";
import { type Harness, machineLimits, machineType } from "./config.ts";
import { decodeJob, JOBS_CHANNEL, type JobSpec, REPORT_LABEL, REPORT_PENDING } from "./jobs.ts";
import { environmentName, repoEnvironment } from "./secrets.ts";

/** Machine labels: every kiln job machine has kiln=worker, its job's ID, and its harness. */
export const MACHINE_LABEL = { kiln: "worker" } as const;
/** Board label counting the machines launched for a job; part of each launch's idempotency key. */
export const LAUNCHES_LABEL = "launches";
export const MAX_LAUNCHES = 3;
/** A machine whose job is still unclaimed after this long never got its worker running. */
export const STARTUP_GRACE_MS = 10 * 60_000;

/** The model credential each harness's machine gets, and only that harness's. */
const HARNESS_CREDENTIAL: Readonly<Record<Harness, string | undefined>> = {
  claude: "CLAUDE_CODE_OAUTH_TOKEN",
  opencode: "AI_GATEWAY_API_KEY",
  // Codex signs in with a ChatGPT login whose refresh token rotates on use; a copy handed to
  // short-lived machines goes stale after the first one. Codex jobs need a long-lived host.
  codex: undefined,
};
const MODEL_CREDENTIALS = new Set(Object.values(HARNESS_CREDENTIAL).filter(Boolean));
const REQUIRED = ["BOARD_TOKEN", "VERCEL_ORG_ID", "GH_TOKEN"] as const;
const ENV_PREFIX = "WORKER_";
const AGENT_BROWSER_VERSION = "0.43.0";
const PNPM = "pnpm@12.11.2";
/** Where the worker finds its settings; it deletes the file once read. */
export const WORKER_SETTINGS_PATH = ".kiln/worker.json";
export const WORKER_LOG_PATH = ".kiln/worker.log";

export interface LaunchConfig {
  /** A tarball of the kiln commit the agent was deployed from, which the machine runs. */
  readonly code: string;
  /** The worker's credentials and settings, by the names the worker reads. */
  readonly settings: Readonly<Record<string, string>>;
  /** Minutes a job may run; the machine's own deadline is this plus a margin. */
  readonly jobTimeoutMinutes: number;
}

/**
 * Reads the launch configuration from the agent's environment: `KILN_WORKER_CODE`, written by
 * `pnpm run deploy`, and every `WORKER_<NAME>` variable, passed to workers as `<NAME>`.
 */
export function launchConfig(env: Readonly<Record<string, string | undefined>>): LaunchConfig | string {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(ENV_PREFIX) && value) settings[key.slice(ENV_PREFIX.length)] = value;
  }
  const missing = [
    ...(env.KILN_WORKER_CODE ? [] : ["KILN_WORKER_CODE (deploy with pnpm run deploy)"]),
    ...REQUIRED.filter((name) => !settings[name]).map((name) => `${ENV_PREFIX}${name}`),
  ];
  if (missing.length > 0) return `set ${missing.join(", ")} on the agent's Vercel project`;
  return {
    code: env.KILN_WORKER_CODE as string,
    settings,
    jobTimeoutMinutes: Number(settings.JOB_TIMEOUT_MINUTES) || 180,
  };
}

/** Why a harness can't run jobs now, or null when it can. */
export function harnessIssue(harness: Harness, config: LaunchConfig): string | null {
  const credential = HARNESS_CREDENTIAL[harness];
  if (!credential) return `kiln can't run ${harness} jobs on per-job machines; use claude or opencode`;
  if (!config.settings[credential])
    return `${harness} jobs need ${ENV_PREFIX}${credential} on the agent's Vercel project`;
  if (machineLimits[harness] < 1) return `${harness} jobs are switched off in lib/config.ts (machineLimits)`;
  return null;
}

/** The worker's settings for one job: the shared ones, its harness's credential, and the job. */
export function workerSettings(
  jobId: string,
  harness: Harness,
  config: LaunchConfig,
): Record<string, string> {
  const own = HARNESS_CREDENTIAL[harness];
  const shared = Object.fromEntries(
    Object.entries(config.settings).filter(([name]) => !MODEL_CREDENTIALS.has(name) || name === own),
  );
  return {
    ...shared,
    BOARD_PROFILE: harness,
    WORKER_HARNESS: harness,
    KILN_JOB_ID: jobId,
    WORK_DIR: "/home/user/work",
    AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/google-chrome-stable",
  };
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Runs once the machine is up, in the background, with the repo environment's secrets in its
 * environment. The worker inherits them; its own credentials come from the settings file.
 */
export function setupScript(code: string): string {
  return [
    "set -euo pipefail",
    `exec >> ~/${WORKER_LOG_PATH} 2>&1`,
    `chmod 700 ~/.kiln && chmod 600 ~/${WORKER_SETTINGS_PATH}`,
    "mkdir -p ~/kiln ~/work",
    `curl -fsSL ${shellQuote(code)} | tar xz --strip-components=1 -C ~/kiln`,
    "cd ~/kiln",
    `npx -y ${PNPM} install --prod --frozen-lockfile --ignore-scripts > /dev/null`,
    `npm ls -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null 2>&1 || npm i -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null`,
    "nohup node worker/main.ts < /dev/null &",
  ].join("\n");
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

export interface MachineDeps {
  readonly team: Board;
  readonly boat: Boat;
  /** The launch configuration, or why there is none. */
  readonly config: LaunchConfig | string;
  readonly log: Log;
  readonly now?: () => number;
}

const shortId = (jobId: string) =>
  jobId
    .replace(/^msg_/, "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8);

/** Fails a job kiln can't run, so its thread hears why instead of waiting. */
async function failJob(team: Board, id: string, reason: string): Promise<void> {
  const claim = await team.tasks.claim(id, { lease: 60 });
  await claim.fail(reason);
  await team.label(id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
}

/**
 * Starts a machine for a ready job. Two launches of the same job at once get the same machine: the
 * idempotency key is the job and its launch count, and boat returns the first machine for a repeat key.
 */
export async function launchMachine(
  deps: MachineDeps,
  job: MessageView,
): Promise<{ machine?: Machine; failed?: string }> {
  const { team, boat, config, log } = deps;
  const spec: JobSpec = decodeJob(job);
  if (typeof config === "string") {
    log("machines.unconfigured", { job: job.id, problem: config });
    return {};
  }
  const issue = harnessIssue(spec.harness, config);
  const launches = Number(job.labels[LAUNCHES_LABEL] ?? 0);
  const reason =
    issue ??
    (launches >= MAX_LAUNCHES
      ? `its worker machine failed to start ${launches} times; see the agent's logs for machines.deleted`
      : null);
  if (reason) {
    await failJob(team, job.id, reason);
    log("machines.job_failed", { job: job.id, reason });
    return { failed: reason };
  }
  const environment = await repoEnvironment(boat, spec.repo, log);
  const machine = await boat.createMachine({
    name: `kiln-${spec.harness}-${shortId(job.id)}`,
    type: machineType,
    environment: environment.name,
    ttlSeconds: (config.jobTimeoutMinutes + 30) * 60,
    labels: { ...MACHINE_LABEL, job: job.id, harness: spec.harness },
    files: [
      {
        path: WORKER_SETTINGS_PATH,
        content: JSON.stringify(workerSettings(job.id, spec.harness, config)),
      },
    ],
    setupScript: setupScript(config.code),
    idempotencyKey: `kiln:${job.id}:${launches}`,
  });
  await team.label(job.id, { set: { [LAUNCHES_LABEL]: String(launches + 1) } });
  log("machines.launched", {
    job: job.id,
    machine: machine.id,
    harness: spec.harness,
    environment: environmentName(spec.repo),
    launch: launches + 1,
  });
  return { machine };
}

export interface ReconcileResult {
  readonly launched: string[];
  readonly deleted: { readonly machine: string; readonly job: string; readonly why: string }[];
  readonly failed: string[];
  readonly waiting: string[];
}

/**
 * The open jobs the agent itself posted. A machine carries push credentials, so a task someone else
 * put in the channel, even labeled as a job, gets none.
 */
async function openJobs(team: Board): Promise<Map<string, MessageView>> {
  const [self, { tasks }] = await Promise.all([
    team.me(),
    team.tasks.list({ channel: JOBS_CHANNEL, state: "open", label: { kiln: "job" }, limit: 100 }),
  ]);
  const jobs = new Map<string, MessageView>();
  for (const { message } of tasks) {
    if (message.by?.actor !== self.actor) continue;
    try {
      decodeJob(message);
      jobs.set(message.id, message);
    } catch {
      // not a job this agent can read
    }
  }
  return jobs;
}

/** Why a machine should go, or null while it is doing its job. */
function deleteReason(machine: Machine, job: MessageView | undefined, now: number): string | null {
  if (!job) return "its job is over";
  const state = job.task?.state;
  if (state === "blocked") return "its job is waiting for an answer";
  if (machine.setupStatus === "failed") return `setup failed: ${machine.setupError ?? "no error given"}`;
  if (state === "ready" && now - Date.parse(machine.createdAt) > STARTUP_GRACE_MS) {
    return "its worker never claimed the job";
  }
  return null;
}

/** Brings the machines in line with the jobs: one per ready or running job, none for anything else. */
export async function reconcileMachines(deps: MachineDeps): Promise<ReconcileResult> {
  const { team, boat, log } = deps;
  const now = (deps.now ?? Date.now)();
  const result: ReconcileResult = { launched: [], deleted: [], failed: [], waiting: [] };
  const [jobs, machines] = await Promise.all([openJobs(team), boat.machines(MACHINE_LABEL)]);

  const live: Machine[] = [];
  for (const machine of machines) {
    const jobId = machine.labels?.job ?? "";
    const why = deleteReason(machine, jobs.get(jobId), now);
    if (!why) {
      live.push(machine);
      continue;
    }
    try {
      await boat.deleteMachine(machine.id);
      result.deleted.push({ machine: machine.id, job: jobId, why });
    } catch (error) {
      // Already going away, or not this key's to delete; either way it no longer counts.
      if (!(error instanceof BoatError && error.status === 404)) {
        log("machines.delete_failed", { machine: machine.id, error: String(error) });
        live.push(machine);
      }
    }
  }

  const covered = new Set(live.map((machine) => machine.labels?.job));
  const running = (harness: string) => live.filter((machine) => machine.labels?.harness === harness).length;
  const ready = [...jobs.values()]
    .filter((job) => job.task?.state === "ready" && !covered.has(job.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const job of ready) {
    const harness = decodeJob(job).harness;
    if (running(harness) >= machineLimits[harness] && machineLimits[harness] > 0) {
      result.waiting.push(job.id);
      continue;
    }
    try {
      const { machine, failed } = await launchMachine(deps, job);
      if (machine) {
        live.push(machine);
        result.launched.push(job.id);
      } else if (failed) result.failed.push(job.id);
      else result.waiting.push(job.id);
    } catch (error) {
      log("machines.launch_failed", { job: job.id, error: String(error) });
      result.waiting.push(job.id);
    }
  }
  return result;
}
