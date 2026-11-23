// One boat machine per job. The agent launches a machine when it starts a job
// and, every minute, reconciles: a machine for each ready job, within each
// harness's limit, and no running machine for a job that isn't running. A job
// that pauses (for an answer, for secrets, for inference) or fails after real
// work keeps its work on its machine: the agent stops the machine, which saves
// its disk and costs nothing, and resumes it when the job is ready again. Every
// other machine is deleted once its job settles.

import type { Board, MessageView } from "@vercel/board";
import { type Boat, BoatError, type Machine, STOPPED } from "./boat.ts";
import { enabledHarnesses, type Harness, keptMachineDays, machineLimits, machineType } from "./config.ts";
import {
  DEFAULT_AGENT_NAME,
  type Deployment,
  parseDeployment,
  projectsOf,
  serversFor,
} from "./deployment.ts";
import { type Inference, inferenceFrom, type ProbeResult, probeInference } from "./inference.ts";
import {
  type Asker,
  decodeJob,
  INFERENCE_KIND,
  JOBS_CHANNEL,
  type JobSpec,
  jobRef,
  KEPT_UNTIL_LABEL,
  NOTICE_LABEL,
  PRIORITY_HIGH,
  PRIORITY_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
  RESUME_LABEL,
  RESUMED_AT_LABEL,
  WAIT_MODEL_LABEL,
  WAIT_SINCE_LABEL,
  WAIT_UNTIL_LABEL,
} from "./jobs.ts";
import { environmentName, repoEnvironment } from "./secrets.ts";

/** Machine labels: every kiln job machine has kiln=worker, its job's ID, and its harness. */
export const MACHINE_LABEL = { kiln: "worker" } as const;
/** Machine label for one launched without snapshots, because the boat account has them off: a stop erases it. */
export const SNAPSHOTS_OFF_LABEL = { snapshots: "off" } as const;
/** Board label counting the machines launched for a job; part of each launch's idempotency key. */
export const LAUNCHES_LABEL = "launches";
/** Board label counting the machines that never got a job's worker running. */
export const FAILED_STARTS_LABEL = "failed_starts";
export const MAX_FAILED_STARTS = 3;
/** A machine whose job is still unclaimed after this long never got its worker running. */
export const STARTUP_GRACE_MS = 10 * 60_000;
/** A job that has waited this long for inference fails, keeping its machine for retry_job. */
export const MAX_INFERENCE_WAIT_MS = 24 * 60 * 60_000;
/** How long to wait before checking the endpoint again when it doesn't say when its limit resets. */
export const INFERENCE_RECHECK_MS = 15 * 60_000;

/** Credentials billed per token: each harness's machine gets its own and no other. */
const KEY_CREDENTIAL: Readonly<Partial<Record<Harness, string>>> = { opencode: "AI_GATEWAY_API_KEY" };
const KEY_CREDENTIALS = new Set(Object.values(KEY_CREDENTIAL));
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
  /** The harnesses workers may run (enabledHarnesses in lib/config.ts). */
  readonly enabled: readonly Harness[];
  /** This deployment's repos and their MCP servers, from KILN_CONFIG. */
  readonly deployment: Deployment;
  /** The deployment's inference endpoint, which Claude jobs run on. */
  readonly inference?: Inference | undefined;
  /** Minutes a job may run; the machine's own deadline is this plus a margin. */
  readonly jobTimeoutMinutes: number;
}

/**
 * The kiln code job machines run: the commit this deployment was built from, when Vercel says which
 * (VERCEL_GIT_*: a Git-connected project, whether it deployed from a push or `pnpm run deploy`), else
 * KILN_WORKER_CODE, which `pnpm run deploy` writes. So agent and workers always run the same commit.
 */
export function workerCode(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const { VERCEL_GIT_PROVIDER, VERCEL_GIT_REPO_OWNER, VERCEL_GIT_REPO_SLUG, VERCEL_GIT_COMMIT_SHA } = env;
  if (
    VERCEL_GIT_PROVIDER === "github" &&
    VERCEL_GIT_REPO_OWNER &&
    VERCEL_GIT_REPO_SLUG &&
    VERCEL_GIT_COMMIT_SHA
  ) {
    return `https://codeload.github.com/${VERCEL_GIT_REPO_OWNER}/${VERCEL_GIT_REPO_SLUG}/tar.gz/${VERCEL_GIT_COMMIT_SHA}`;
  }
  return env.KILN_WORKER_CODE || undefined;
}

/**
 * Reads the launch configuration from the agent's environment: the worker code (see workerCode),
 * every `WORKER_<NAME>` variable, passed to workers as `<NAME>`, and the inference endpoint
 * (INFERENCE_BASE_URL and INFERENCE_API_KEY), which goes only to Claude jobs.
 */
export function launchConfig(env: Readonly<Record<string, string | undefined>>): LaunchConfig | string {
  const settings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(ENV_PREFIX) && value) settings[key.slice(ENV_PREFIX.length)] = value;
  }
  const code = workerCode(env);
  const missing = [
    ...(code ? [] : ["KILN_WORKER_CODE (deploy with pnpm run deploy)"]),
    ...REQUIRED.filter((name) => !settings[name]).map((name) => `${ENV_PREFIX}${name}`),
  ];
  if (missing.length > 0) return `set ${missing.join(", ")} on the agent's Vercel project`;
  const deployment = parseDeployment(env.KILN_CONFIG);
  if (typeof deployment === "string") return deployment;
  const inference = inferenceFrom(env);
  if (typeof inference === "string") return `${inference} on the agent's Vercel project`;
  return {
    inference,
    enabled: enabledHarnesses,
    deployment,
    code: code as string,
    settings,
    jobTimeoutMinutes: Number(settings.JOB_TIMEOUT_MINUTES) || 180,
  };
}

/** Why a harness can't run jobs at all, or null when it can. */
export function harnessIssue(harness: Harness, config: LaunchConfig): string | null {
  if (!config.enabled.includes(harness)) {
    return `${harness} is off: workers run Claude Code only (enabledHarnesses in lib/config.ts)`;
  }
  if (harness === "claude") {
    if (!config.inference) {
      return "claude jobs need INFERENCE_BASE_URL and INFERENCE_API_KEY on the agent's Vercel project";
    }
    return (machineLimits.claude ?? 0) < 1
      ? "claude jobs are switched off in lib/config.ts (machineLimits)"
      : null;
  }
  const credential = KEY_CREDENTIAL[harness];
  // Codex signs in with a ChatGPT login whose refresh token rotates on use; a copy handed to
  // short-lived machines goes stale after the first one.
  if (!credential) return `kiln can't run ${harness} jobs on per-job machines yet; use claude or opencode`;
  if (!config.settings[credential])
    return `${harness} jobs need ${ENV_PREFIX}${credential} on the agent's Vercel project`;
  if ((machineLimits[harness] ?? 0) < 1)
    return `${harness} jobs are switched off in lib/config.ts (machineLimits)`;
  return null;
}

/**
 * The worker's settings for one job: the shared ones, its harness's credential, and the job. A Claude
 * job gets the inference endpoint.
 */
export function workerSettings(
  jobId: string,
  harness: Harness,
  config: LaunchConfig,
  repo?: string,
): Record<string, string> {
  const servers = repo ? serversFor(config.deployment, repo) : {};
  const project = repo ? projectsOf(config.deployment)[repo] : undefined;
  const own = KEY_CREDENTIAL[harness];
  const shared = Object.fromEntries(
    Object.entries(config.settings).filter(([name]) => !KEY_CREDENTIALS.has(name) || name === own),
  );
  return {
    ...shared,
    ...(harness === "claude" && config.inference
      ? { INFERENCE_BASE_URL: config.inference.baseURL, INFERENCE_API_KEY: config.inference.apiKey }
      : {}),
    ...(repo && project
      ? {
          KILN_REPO: JSON.stringify({
            key: repo,
            repos: project.repos.map(({ key, github, baseBranch }) => ({
              key,
              github,
              ...(baseBranch ? { baseBranch } : {}),
            })),
          }),
        }
      : {}),
    KILN_AGENT_NAME: config.deployment.name ?? DEFAULT_AGENT_NAME,
    ...(Object.keys(servers).length > 0 ? { KILN_MCP_SERVERS: JSON.stringify(servers) } : {}),
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
    // A resumed machine runs this again: the agent's current commit replaces the code it started with.
    "rm -rf ~/kiln && mkdir -p ~/kiln ~/work",
    `curl -fsSL ${shellQuote(code)} | tar xz --strip-components=1 -C ~/kiln`,
    "cd ~/kiln",
    `npx -y ${PNPM} install --prod --frozen-lockfile --ignore-scripts > /dev/null`,
    `npm ls -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null 2>&1 || npm i -g agent-browser@${AGENT_BROWSER_VERSION} > /dev/null`,
    "nohup node worker/main.ts < /dev/null &",
  ].join("\n");
}

export type Log = (event: string, fields?: Record<string, unknown>) => void;

/** Tells the people whose jobs wait for inference, once per outage, and updates that same message after. */
export interface InferenceNotices {
  /** Says jobs are paused until about `until`; returns where it said it, for the updates. */
  paused(asker: Asker, until: number): Promise<string>;
  /** Says inference is back and the jobs are continuing. */
  back(notice: string, since: number): Promise<void>;
  /** Says these jobs gave up waiting and failed, with their work kept. */
  gaveUp(notice: string, jobs: readonly string[]): Promise<void>;
}

export interface MachineDeps {
  readonly team: Board;
  readonly boat: Boat;
  /** The launch configuration, or why there is none. */
  readonly config: LaunchConfig | string;
  readonly log: Log;
  readonly now?: () => number;
  /** Checks whether the inference endpoint serves `model` again. Default: one real request. */
  readonly probe?: (model: string) => Promise<ProbeResult>;
  /** The model to check the endpoint with when the refusal named none: the agent's own. */
  readonly probeModel?: string;
  readonly notices?: InferenceNotices;
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
  const failedStarts = Number(job.labels[FAILED_STARTS_LABEL] ?? 0);
  const reason =
    (projectsOf(config.deployment)[spec.repo]
      ? null
      : `${spec.repo} is no longer a repo or project in kiln.config.yaml`) ??
    harnessIssue(spec.harness, config) ??
    (failedStarts >= MAX_FAILED_STARTS
      ? `its worker machine failed to start ${failedStarts} times; see the agent's logs for machines.reconciled`
      : null);
  if (reason) {
    await failJob(team, job.id, reason);
    log("machines.job_failed", { job: job.id, reason });
    return { failed: reason };
  }
  const launches = Number(job.labels[LAUNCHES_LABEL] ?? 0);
  // Before the machine exists, so a second pass at once reuses its idempotency key rather than launching another.
  await team.label(job.id, { set: { [LAUNCHES_LABEL]: String(launches + 1) } });
  const environment = await repoEnvironment(boat, spec.repo, log);
  const create = (snapshots: boolean) =>
    boat.createMachine({
      name: `kiln-${spec.harness}-${shortId(job.id)}`,
      type: machineType,
      environment: environment.name,
      ttlSeconds: (config.jobTimeoutMinutes + 30) * 60,
      labels: {
        ...MACHINE_LABEL,
        job: job.id,
        harness: spec.harness,
        ...(snapshots ? {} : SNAPSHOTS_OFF_LABEL),
      },
      files: [
        {
          path: WORKER_SETTINGS_PATH,
          content: JSON.stringify(workerSettings(job.id, spec.harness, config, spec.repo)),
        },
      ],
      setupScript: setupScript(config.code),
      // Snapshots keep a stopped machine's disk, so a paused or failed job continues on it.
      snapshots,
      idempotencyKey: `kiln:${job.id}:${launches}${snapshots ? "" : ":no-snapshots"}`,
    });
  let machine: Machine;
  try {
    machine = await create(true);
  } catch (error) {
    if (!(error instanceof BoatError && error.code === "snapshots_off_for_account")) throw error;
    // The job still runs; only its work can't be kept if it pauses or fails. The account setting turns them on.
    log("machines.snapshots_off", {
      job: job.id,
      fix: "turn snapshots on in boat's dashboard, Account tab, so paused and failed jobs keep their work",
    });
    machine = await create(false);
  }
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
  /** Jobs whose stopped machine was resumed, to continue on it. */
  readonly resumed: string[];
  readonly stopped: { readonly machine: string; readonly job: string; readonly why: string }[];
  readonly deleted: { readonly machine: string; readonly job: string; readonly why: string }[];
  readonly failed: string[];
  /** Jobs held back by a harness's limit, or while inference is rate limited. */
  readonly waiting: string[];
  /** Whether Claude jobs are held because inference is rate limited. */
  readonly inferenceHeld: boolean;
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

/** A job's task as the board has it now, open or not. Undefined when the board has no such task. */
async function jobRoot(team: Board, id: string): Promise<MessageView | undefined> {
  if (!id) return undefined;
  try {
    return (await team.thread(id, { limit: 1 })).message;
  } catch {
    return undefined;
  }
}

const isRunning = (machine: Machine) => ["ready", "idle", "running"].includes(machine.state);
const since = (job: MessageView, label: string) => Date.parse(job.labels[label] ?? "") || undefined;
const waitsForInference = (job: MessageView) =>
  job.task?.state === "blocked" && job.task.blocked?.kind === INFERENCE_KIND;

type Disposition =
  | { readonly act: "keep" }
  /** A resumed machine whose worker the agent starts. */
  | { readonly act: "start" }
  | { readonly act: "stop"; readonly why: string }
  | { readonly act: "delete"; readonly why: string; readonly failedStart?: boolean };

/** What to do with a machine, given its job. */
function disposition(machine: Machine, job: MessageView | undefined, now: number): Disposition {
  if (!job) return { act: "delete", why: "its job is over" };
  const state = job.task?.state;
  const stopped = machine.state === STOPPED;
  // Without snapshots a stop erases the machine, so there is no keeping its work.
  const keepable = machine.labels?.snapshots !== SNAPSHOTS_OFF_LABEL.snapshots;
  const holdsWork = job.labels[RESUME_LABEL] !== undefined && keepable;
  // A stop in progress: act once boat has saved the disk.
  if (machine.state === "archiving") return { act: "keep" };
  if (state === "failed") {
    const until = since(job, KEPT_UNTIL_LABEL);
    if (holdsWork && (until === undefined || until > now)) {
      return stopped
        ? { act: "keep" }
        : { act: "stop", why: "its job failed; its work is kept for retry_job" };
    }
    return { act: "delete", why: holdsWork ? "its job's kept work expired" : "its job is over" };
  }
  if (state === "blocked") {
    if (holdsWork) {
      return stopped ? { act: "keep" } : { act: "stop", why: "its job is paused; its work is kept" };
    }
    return { act: "delete", why: "its job is waiting for an answer" };
  }
  if (state !== "ready") {
    if (state === "claimed" || state === "waiting") return { act: "keep" };
    return { act: "delete", why: "its job is over" };
  }
  // A ready job: a stopped machine is resumed for it below, within the limits.
  if (stopped) return { act: "keep" };
  if (machine.setupStatus === "failed") {
    return {
      act: "delete",
      why: `setup failed: ${machine.setupError ?? "no error given"}`,
      failedStart: true,
    };
  }
  const resumedAt = since(job, RESUMED_AT_LABEL);
  const startedAt = Math.max(Date.parse(machine.createdAt), resumedAt ?? 0);
  if (now - startedAt > STARTUP_GRACE_MS) {
    return { act: "delete", why: "its worker never claimed the job", failedStart: true };
  }
  return resumedAt !== undefined && resumedAt > Date.parse(machine.createdAt) && isRunning(machine)
    ? { act: "start" }
    : { act: "keep" };
}

/**
 * Starts the worker on a machine resumed for its job, once per resume: boat doesn't run the setup
 * script again, and running programs don't survive a stop. The settings go in a file, as at launch,
 * never in the command, which boat keeps in the machine's history.
 */
async function startResumed(deps: MachineDeps, config: LaunchConfig, machine: Machine, job: MessageView) {
  const marker = `~/.kiln/started-${since(job, RESUMED_AT_LABEL) ?? 0}`;
  const claimed = await deps.boat.run(
    machine.id,
    `mkdir -p ~/.kiln && mkdir ${marker} 2>/dev/null && echo start || echo started`,
  );
  if (claimed !== "start") return;
  const spec = decodeJob(job);
  await deps.boat.writeFile(
    machine.id,
    WORKER_SETTINGS_PATH,
    JSON.stringify(workerSettings(job.id, spec.harness, config, spec.repo)),
  );
  await deps.boat.startCommand(machine.id, setupScript(config.code));
  deps.log("machines.worker_started", { job: job.id, machine: machine.id });
}

/** Resumes a job's stopped machine on the latest version of its secrets, so it continues where it stopped. */
async function resumeMachine(deps: MachineDeps, config: LaunchConfig, machine: Machine, job: MessageView) {
  const spec = decodeJob(job);
  const environment = await repoEnvironment(deps.boat, spec.repo, deps.log);
  try {
    await deps.boat.upgradeEnvironment(environment.id, machine.id);
  } catch (error) {
    // Most often nothing to upgrade. A job paused for secrets that resumes without them asks again.
    deps.log("machines.upgrade_skipped", { job: job.id, machine: machine.id, error: String(error) });
  }
  // Before the resume, so the next pass knows to start its worker and when its startup grace began.
  await deps.team.label(job.id, {
    set: { [RESUMED_AT_LABEL]: new Date((deps.now ?? Date.now)()).toISOString() },
    unset: [KEPT_UNTIL_LABEL],
  });
  await deps.boat.resumeMachine(machine.id, (config.jobTimeoutMinutes + 30) * 60);
  deps.log("machines.resumed", { job: job.id, machine: machine.id, continuing: job.labels[RESUME_LABEL] });
}

/** The person a job reports to, for the outage notice. */
const askerOfJob = (job: MessageView): Asker | undefined => {
  try {
    return decodeJob(job).origin?.asker;
  } catch {
    return undefined;
  }
};

/** Tells each asker whose jobs wait for inference, once: one message per person, shared by their jobs. */
async function tellAskers(deps: MachineDeps, waiting: readonly MessageView[]): Promise<void> {
  const { notices, team, log } = deps;
  if (!notices) return;
  const told = new Map<string, string>();
  for (const job of waiting) {
    const asker = askerOfJob(job);
    const notice = job.labels[NOTICE_LABEL];
    if (asker && notice) told.set(asker.principalId, notice);
  }
  for (const job of waiting) {
    if (job.labels[NOTICE_LABEL]) continue;
    const asker = askerOfJob(job);
    if (!asker?.userId) continue;
    let notice = told.get(asker.principalId);
    if (!notice) {
      try {
        notice = await notices.paused(asker, since(job, WAIT_UNTIL_LABEL) ?? Date.now());
      } catch (error) {
        log("inference.notice_failed", { job: job.id, error: String(error) });
        continue;
      }
      told.set(asker.principalId, notice);
    }
    await team.label(job.id, { set: { [NOTICE_LABEL]: notice } });
  }
}

/** The notices on these jobs, each once. */
const noticesOf = (jobs: readonly MessageView[]) => [
  ...new Set(jobs.map((job) => job.labels[NOTICE_LABEL]).filter((notice): notice is string => !!notice)),
];

const WAIT_LABELS = [WAIT_UNTIL_LABEL, WAIT_SINCE_LABEL, WAIT_MODEL_LABEL, NOTICE_LABEL];

/**
 * Jobs paused because the inference endpoint was rate limited: tells their askers, checks the endpoint
 * once one is due, and returns every paused job to the queue once it answers. Gives up on a job after a
 * day. Returns whether Claude jobs must still wait: none start while inference is rate limited.
 */
async function holdForInference(
  deps: MachineDeps,
  config: LaunchConfig,
  jobs: Map<string, MessageView>,
  now: number,
): Promise<boolean> {
  const { team, log } = deps;
  let waiting = [...jobs.values()].filter(waitsForInference);
  if (waiting.length === 0) return false;

  const expired = waiting.filter(
    (job) => now - (since(job, WAIT_SINCE_LABEL) ?? now) > MAX_INFERENCE_WAIT_MS,
  );
  for (const job of expired) {
    await team.tasks.unblock(job.id);
    await failJob(team, job.id, "inference stayed rate limited for a day; its work is kept for retry_job");
    await team.label(job.id, { unset: WAIT_LABELS });
    jobs.delete(job.id);
    log("inference.gave_up", { job: job.id });
  }
  for (const notice of noticesOf(expired)) {
    await deps.notices
      ?.gaveUp(
        notice,
        expired.filter((job) => job.labels[NOTICE_LABEL] === notice).map((job) => `#${jobRef(job.id)}`),
      )
      .catch((error: unknown) => log("inference.notice_failed", { notice, error: String(error) }));
  }
  waiting = waiting.filter((job) => !expired.includes(job));
  if (waiting.length === 0) return false;

  await tellAskers(deps, waiting);
  const due = waiting.filter((job) => (since(job, WAIT_UNTIL_LABEL) ?? 0) <= now);
  if (due.length === 0) return true;

  const oldest = due.sort((a, b) => (since(a, WAIT_SINCE_LABEL) ?? 0) - (since(b, WAIT_SINCE_LABEL) ?? 0))[0];
  const model = oldest?.labels[WAIT_MODEL_LABEL] ?? deps.probeModel;
  if (!config.inference) return false;
  const probe = deps.probe ?? ((name: string) => probeInference(config.inference as Inference, name));
  // With no model to ask about, the reset time the endpoint gave is all there is to go on.
  const answer: ProbeResult = model ? await probe(model) : { ok: true };
  if (!answer.ok) {
    const next = new Date(now + (answer.limit?.resetMs ?? INFERENCE_RECHECK_MS)).toISOString();
    for (const job of due) await team.label(job.id, { set: { [WAIT_UNTIL_LABEL]: next } });
    log("inference.still_limited", { model, next, why: answer.why, waiting: waiting.length });
    return true;
  }
  // Fresh labels for the notices: tellAskers may have just set them.
  const current = await Promise.all(waiting.map(async (job) => (await jobRoot(team, job.id)) ?? job));
  const firstWait = Math.min(...current.map((job) => since(job, WAIT_SINCE_LABEL) ?? now));
  for (const job of current) {
    await team.label(job.id, { unset: WAIT_LABELS });
    const ready = await team.tasks.unblock(job.id);
    jobs.set(job.id, ready);
  }
  for (const notice of noticesOf(current)) {
    await deps.notices
      ?.back(notice, firstWait)
      .catch((error: unknown) => log("inference.notice_failed", { notice, error: String(error) }));
  }
  log("inference.back", { model, continuing: current.map((job) => job.id) });
  return false;
}

/**
 * Brings the machines in line with the jobs: a running machine for each ready or running job, within
 * each harness's limit; a stopped one for a paused job, or a failed one whose work is kept; none for
 * anything else. A ready job with a stopped machine resumes on it.
 */
export async function reconcileMachines(deps: MachineDeps): Promise<ReconcileResult> {
  const { team, boat, log, config } = deps;
  const now = (deps.now ?? Date.now)();
  const result: ReconcileResult = {
    launched: [],
    resumed: [],
    stopped: [],
    deleted: [],
    failed: [],
    waiting: [],
    inferenceHeld: false,
  };
  const [jobs, machines] = await Promise.all([openJobs(team), boat.machines(MACHINE_LABEL)]);
  const inferenceHeld = typeof config === "string" ? false : await holdForInference(deps, config, jobs, now);

  const live: Machine[] = [];
  const stopped = new Map<string, Machine>();
  for (const machine of machines) {
    const jobId = machine.labels?.job ?? "";
    const job = jobs.get(jobId) ?? (await jobRoot(team, jobId));
    const action = disposition(machine, job, now);
    try {
      // A failed job's work is kept for a while, whether this pass stops its machine or found it stopped.
      if (
        job?.task?.state === "failed" &&
        job.labels[RESUME_LABEL] !== undefined &&
        !job.labels[KEPT_UNTIL_LABEL]
      ) {
        const until = new Date(now + keptMachineDays * 24 * 60 * 60_000).toISOString();
        await team.label(jobId, { set: { [KEPT_UNTIL_LABEL]: until } });
      }
      if (action.act === "keep" || action.act === "start") {
        if (machine.state === STOPPED) stopped.set(jobId, machine);
        else live.push(machine);
        if (action.act === "start" && job && typeof config !== "string") {
          await startResumed(deps, config, machine, job);
        }
      } else if (action.act === "stop") {
        await boat.stopMachine(machine.id);
        result.stopped.push({ machine: machine.id, job: jobId, why: action.why });
      } else {
        await boat.deleteMachine(machine.id);
        result.deleted.push({ machine: machine.id, job: jobId, why: action.why });
        if (job && job.labels[RESUME_LABEL] !== undefined) {
          // Its work went with it: a later run starts over.
          await team.label(jobId, { unset: [RESUME_LABEL, KEPT_UNTIL_LABEL] });
        }
        if (action.failedStart && job) {
          await team.label(jobId, {
            set: { [FAILED_STARTS_LABEL]: String(Number(job.labels[FAILED_STARTS_LABEL] ?? 0) + 1) },
          });
        }
      }
    } catch (error) {
      // Already gone, or not this key's: it no longer counts. Anything else is tried again next minute.
      if (!(error instanceof BoatError && error.status === 404)) {
        log("machines.action_failed", { machine: machine.id, act: action.act, error: String(error) });
        if (machine.state === STOPPED) stopped.set(jobId, machine);
        else live.push(machine);
      }
    }
  }

  const covered = new Set(live.map((machine) => machine.labels?.job));
  const running = (harness: string) => live.filter((machine) => machine.labels?.harness === harness).length;
  // Jobs that have work to continue go first, then priority jobs, then the queue, oldest first.
  const urgent = (job: MessageView) => Number(job.labels[PRIORITY_LABEL] === PRIORITY_HIGH);
  const ready = [...jobs.values()]
    .filter((job) => job.task?.state === "ready" && !covered.has(job.id))
    .sort(
      (a, b) =>
        Number(stopped.has(b.id)) - Number(stopped.has(a.id)) ||
        urgent(b) - urgent(a) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  for (const job of ready) {
    const spec = decodeJob(job);
    try {
      const limit = machineLimits[spec.harness] ?? 0;
      if ((spec.harness === "claude" && inferenceHeld) || (limit > 0 && running(spec.harness) >= limit)) {
        result.waiting.push(job.id);
        continue;
      }
      const kept = stopped.get(job.id);
      if (kept && typeof config !== "string") {
        try {
          await resumeMachine(deps, config, kept, job);
          live.push(kept);
          result.resumed.push(job.id);
        } catch (error) {
          if (!(error instanceof BoatError && error.status === 409)) throw error;
          // Its saved disk is gone or won't come back: start the job over on a fresh machine next minute.
          log("machines.resume_failed", { job: job.id, machine: kept.id, error: String(error) });
          await boat.deleteMachine(kept.id).catch(() => {});
          await team.label(job.id, { unset: [RESUME_LABEL, KEPT_UNTIL_LABEL, RESUMED_AT_LABEL] });
          result.waiting.push(job.id);
        }
        continue;
      }
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
  return { ...result, inferenceHeld };
}

/** Deletes the machine a job's work is kept on, so its next run starts over from a fresh clone. */
export async function discardKeptMachine(
  deps: Pick<MachineDeps, "team" | "boat">,
  jobId: string,
): Promise<boolean> {
  const machines = await deps.boat.machines({ ...MACHINE_LABEL, job: jobId });
  for (const machine of machines) await deps.boat.deleteMachine(machine.id);
  await deps.team.label(jobId, { unset: [RESUME_LABEL, KEPT_UNTIL_LABEL] });
  return machines.length > 0;
}
