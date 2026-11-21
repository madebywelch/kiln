// One job, from a held claim to a settled task: clone, branch, run the
// harness, push and open a draft PR (for changes), report, settle.

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Board, ClaimedTask } from "@vercel/board";
import { benchedUntil, readLedger, usageLabels, type WorkerSubscription } from "../lib/accounts.ts";
import { agent } from "../lib/config.ts";
import type { McpServer, RepoConfig } from "../lib/deployment.ts";
import {
  decodeJob,
  describeSelection,
  type JobSpec,
  jobBranch,
  NEEDS_SECRET_KIND,
  NEEDS_SECRETS_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
} from "../lib/jobs.ts";
import { ACCOUNT_LABEL, WAITING_LABEL } from "../lib/machines.ts";
import { type Exec, type ExecResult, run } from "./exec.ts";
import {
  ClaudeWatch,
  type HarnessBins,
  type HarnessInvocation,
  harnessInvocation,
  MissingSecrets,
  resolveMcp,
} from "./harness.ts";

export type Logger = (event: string, fields?: Record<string, unknown>) => void;

export type OpenPullRequest = (input: {
  readonly cwd: string;
  readonly github: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly body: string;
}) => Promise<string>;

/** Why a job stopped without settling. The task's claim is released only on shutdown. */
export const SHUTDOWN = "shutdown";
export const CLAIM_LOST = "claim lost";

export interface JobDeps {
  readonly board: Board;
  readonly claim: ClaimedTask;
  readonly profile: string;
  readonly workDir: string;
  readonly exec: Exec;
  readonly cloneUrl: (github: string) => string;
  readonly openPullRequest: OpenPullRequest;
  readonly timeoutMs: number;
  /** Aborted with SHUTDOWN or CLAIM_LOST as its reason. */
  readonly signal: AbortSignal;
  readonly log: Logger;
  readonly bins?: HarnessBins;
  /** The job's repo, from the agent (KILN_REPO). */
  readonly registry?: Readonly<Record<string, Pick<RepoConfig, "github" | "baseBranch">>>;
  readonly gitIdentity?: { readonly name: string; readonly email: string };
  /** The coding CLI's environment. Default: the worker's, without its credentials (see harnessEnv). */
  readonly harnessEnv?: NodeJS.ProcessEnv;
  /** Your own guidance for every job, from worker/instructions.md. */
  readonly guidance?: string;
  /** The repo's MCP servers, from the agent (KILN_MCP_SERVERS). Their ${NAME}s come from the environment. */
  readonly mcpServers?: Readonly<Record<string, McpServer>>;
  /** For a Claude job: the subscriptions it may use, in the order to try them. Empty: the CLI's own login. */
  readonly subscriptions?: readonly WorkerSubscription[];
}

/** Why the worker stopped a run itself: its subscription ran out. */
const EXHAUSTED = "subscription exhausted";
const CONTINUE_PROMPT =
  "Your last turn was cut off because its subscription ran out of usage. Continue the job from where you stopped. Everything above still applies.";

/** Credentials only the worker holds: its push token and its board login. */
const WORKER_SECRETS = [
  "KILN_SUBSCRIPTIONS", // every subscription's token; the CLI gets only its own, as CLAUDE_CODE_OAUTH_TOKEN
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "HARNESS_GH_TOKEN",
  "BOARD_TOKEN",
  "VERCEL_TOKEN",
  "VERCEL_AUTH_TOKEN",
];

/**
 * The environment the coding CLI runs in. It runs with permission prompts off,
 * so it gets none of the worker's credentials: the worker alone pushes and
 * opens pull requests. `readToken`, a read-only GitHub token, becomes its
 * GH_TOKEN so it can still read CI runs and issues with gh.
 */
export function harnessEnv(env: NodeJS.ProcessEnv, readToken?: string): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const name of WORKER_SECRETS) delete out[name];
  if (readToken) out.GH_TOKEN = readToken;
  return out;
}

export type Outcome =
  | { readonly kind: "completed"; readonly result: string; readonly report: string }
  | { readonly kind: "failed"; readonly reason: string; readonly report: string }
  | {
      readonly kind: "blocked";
      readonly question: string;
      readonly report: string;
      /** The repo secrets it waits for, when it is paused for secrets rather than an answer. */
      readonly secrets?: readonly string[];
    }
  /** Every subscription that can run the job's model is out of usage until `until` (unix seconds). */
  | { readonly kind: "waiting"; readonly until: number; readonly report: string }
  | { readonly kind: "abandoned"; readonly why: string };

const MAX_SETTLE_CHARS = 900; // the local board caps results and reasons at 1,000
const MAX_REPLY_CHARS = 9_500; // a message holds 10,000
const LOG_TAIL_CHARS = 3_000;
const QUESTION = /^QUESTION:\s*/i;
/** A final message naming credentials the CLI needs: `SECRET: NAME, OTHER_NAME: what for`. */
const SECRET = /^SECRET:\s*([A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)\s*(?:[:\u2014-]\s*)?([\s\S]*)$/;

/** Where the CLI puts files to share, relative to the clone. */
export const ARTIFACTS_DIR = ".kiln/artifacts";
const MAX_ARTIFACTS = 10;
const MAX_ARTIFACT_MB = 20;

export interface Artifact {
  readonly name: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** The files the CLI left to share: top-level files only, the first ten by name, none over the size cap. */
export async function collectArtifacts(dir: string): Promise<Artifact[]> {
  let names: string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  const artifacts: Artifact[] = [];
  for (const name of names.slice(0, MAX_ARTIFACTS)) {
    const path = join(dir, name);
    if ((await stat(path)).size > MAX_ARTIFACT_MB * 1024 * 1024) continue;
    artifacts.push({ name, bytes: new Uint8Array(await readFile(path)) });
  }
  return artifacts;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}m`;
}

class JobFailure extends Error {
  readonly report: string;
  constructor(message: string, report: string) {
    super(message);
    this.report = report;
  }
}

const STARTED = "Started by ";

export async function runJob(deps: JobDeps): Promise<Outcome> {
  const { claim, log } = deps;
  const id = claim.task.id;
  const logFile = join(deps.workDir, "logs", `${id}.log`);
  const jobDir = join(deps.workDir, "jobs", id);
  await mkdir(dirname(logFile), { recursive: true });

  let outcome: Outcome;
  try {
    outcome = await execute(deps, jobDir, logFile);
  } catch (error) {
    if (deps.signal.aborted) {
      outcome = { kind: "abandoned", why: String(deps.signal.reason) };
    } else {
      const message = error instanceof Error ? error.message : String(error);
      const report = error instanceof JobFailure ? error.report : await logTail(logFile);
      outcome = { kind: "failed", reason: message, report };
    }
  }

  const artifacts =
    outcome.kind === "abandoned" || outcome.kind === "waiting"
      ? []
      : await collectArtifacts(join(jobDir, ARTIFACTS_DIR));
  log("job.outcome", { task: id, outcome: outcome.kind, artifacts: artifacts.length });
  await settle(deps, outcome, artifacts);
  await rm(jobDir, { recursive: true, force: true });
  return outcome;
}

async function execute(deps: JobDeps, jobDir: string, logFile: string): Promise<Outcome> {
  const { board, claim, exec, signal } = deps;
  const id = claim.task.id;
  const spec = decodeJob(claim.task);
  const repo = deps.registry?.[spec.repo];
  if (!repo) throw new Error(`repo "${spec.repo}" is not in this job's settings from the agent`);
  const base = repo.baseBranch ?? "main";
  const branch = jobBranch(id, spec.title);
  const git = (args: readonly string[]) => run(exec, "git", args, { cwd: jobDir, signal });

  await board.reply(id, `${STARTED}${deps.profile}: ${describeSelection(spec)} on ${repo.github}.`);

  let mcp: ReturnType<typeof resolveMcp>;
  try {
    const servers = deps.mcpServers ?? {};
    mcp = resolveMcp(servers, Object.keys(servers), process.env);
  } catch (error) {
    if (!(error instanceof MissingSecrets)) throw error;
    // Nothing has run yet: wait for the secrets instead of failing.
    return {
      kind: "blocked",
      question: `Set ${error.names.join(", ")} for ${spec.repo}; its MCP servers need ${error.names.length > 1 ? "them" : "it"}.`,
      report: "",
      secrets: error.names,
    };
  }

  await rm(jobDir, { recursive: true, force: true });
  await mkdir(dirname(jobDir), { recursive: true });
  const url = deps.cloneUrl(repo.github);
  const mirror = await refreshMirror(
    exec,
    join(deps.workDir, "mirrors", `${repo.github.replace("/", "__")}.git`),
    url,
    signal,
  );
  // Objects come from the local mirror; only what changed since its fetch crosses the network.
  await run(exec, "git", ["clone", "--quiet", "--reference", mirror, url, jobDir], { signal });
  const identity = deps.gitIdentity ?? {
    name: `${agent.name} (${deps.profile})`,
    email: "kiln@users.noreply.github.com",
  };
  await git(["config", "user.name", identity.name]);
  await git(["config", "user.email", identity.email]);
  // Files the CLI shares go in .kiln/artifacts; they are attached to the report, never committed.
  await appendFile(join(jobDir, ".git", "info", "exclude"), `\n${ARTIFACTS_DIR.split("/")[0]}/\n`);

  // A job that blocked for an answer pushed its work; the next run continues from it.
  const resumed =
    (await exec("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: jobDir })).code ===
    0;
  await git(["switch", "--quiet", "-c", branch, resumed ? `origin/${branch}` : `origin/${base}`]);
  const startSha = await git(["rev-parse", "HEAD"]);

  const thread = await board.thread(id, { limit: 100 });
  const earlier = thread.replies.filter((reply) => !reply.text.startsWith(STARTED));
  const prompt = buildPrompt(spec, { id, github: repo.github, branch, resumed }, earlier, deps.guidance);
  const reportFile = join(deps.workDir, "logs", `${id}.report.md`);
  const subscriptions = spec.harness === "claude" ? (deps.subscriptions ?? []) : [];
  let current = 0;
  let session: string | undefined;
  let invocation: HarnessInvocation;
  let result: ExecResult;
  const started = Date.now();
  for (;;) {
    const subscription = subscriptions[current];
    invocation = harnessInvocation(
      spec,
      session ? CONTINUE_PROMPT : prompt,
      jobDir,
      reportFile,
      mcp,
      deps.bins,
      session,
    );
    deps.log("job.harness", {
      task: id,
      harness: spec.harness,
      model: spec.model ?? "default",
      effort: spec.effort,
      ...(subscription ? { subscription: subscription.id } : {}),
      ...(session ? { resumed: session } : {}),
    });
    const watch = spec.harness === "claude" ? new ClaudeWatch() : undefined;
    // Stopping the run is the worker's own decision when the subscription runs out, and the job's on shutdown.
    const runStop = new AbortController();
    const onJobStop = () => runStop.abort(signal.reason);
    signal.addEventListener("abort", onJobStop, { once: true });
    try {
      result = await exec(invocation.command, invocation.args, {
        cwd: jobDir,
        input: invocation.stdin,
        env: {
          ...(deps.harnessEnv ?? harnessEnv(process.env)),
          ...invocation.env,
          ...(subscription ? { CLAUDE_CODE_OAUTH_TOKEN: subscription.token } : {}),
        },
        signal: runStop.signal,
        timeoutMs: Math.max(1_000, deps.timeoutMs - (Date.now() - started)),
        onOutput: (chunk) => {
          void appendFile(logFile, chunk);
          watch?.feed(chunk);
          // Claude Code may wait out a limit instead of exiting; there is another subscription to use.
          if (watch?.exhausted && !runStop.signal.aborted) runStop.abort(EXHAUSTED);
        },
      });
    } finally {
      signal.removeEventListener("abort", onJobStop);
    }
    if (signal.aborted) throw new Error(String(signal.reason));
    session = watch?.sessionId ?? session;
    const exhausted = watch?.exhausted;
    if (subscription && watch) await recordUsage(deps, subscription, watch, spec.model);
    if (!exhausted || !subscription) break;

    const states = await readLedger(board, "claude").catch(() => new Map());
    const nowSeconds = Math.floor(Date.now() / 1000);
    const next = subscriptions.findIndex((candidate, index) => {
      if (index === current) return false;
      const state = states.get(candidate.id);
      return !state || benchedUntil(state, spec.model, nowSeconds) === null;
    });
    const resetsAt = exhausted.resetsAt ? new Date(exhausted.resetsAt * 1000).toISOString() : "later";
    if (next >= 0 && session) {
      const to = subscriptions[next] as WorkerSubscription;
      await board.label(id, { set: { [ACCOUNT_LABEL]: to.id } });
      await board.reply(
        id,
        `Subscription ${subscription.id} is out of usage (${exhausted.rateLimitType ?? "limit"}, resets ${resetsAt}); continuing on ${to.id}, same model.`,
      );
      deps.log("job.subscription_switched", {
        task: id,
        from: subscription.id,
        to: to.id,
        window: exhausted.rateLimitType ?? null,
      });
      current = next;
      continue;
    }
    if (spec.kind === "change") await pushWork(git, spec.title, startSha, branch);
    const resets = subscriptions
      .map((candidate) => {
        const state = states.get(candidate.id);
        return state ? benchedUntil(state, spec.model, nowSeconds) : null;
      })
      .filter((until): until is number => until !== null);
    const until = Math.min(...resets, exhausted.resetsAt ?? nowSeconds + 3600);
    deps.log("job.waiting", { task: id, until });
    return {
      kind: "waiting",
      until,
      report: `Every subscription that can run ${describeSelection(spec)} is out of usage. The earliest resets at ${new Date(until * 1000).toISOString()}.${spec.kind === "change" ? ` Work so far is on ${branch}.` : ""}`,
    };
  }
  if (result.timedOut) {
    throw new JobFailure(`${spec.harness} timed out after ${minutes(deps.timeoutMs)}`, tail(result));
  }
  if (result.code !== 0) throw new JobFailure(`${spec.harness} exited ${result.code}`, tail(result));
  deps.log("job.harness_done", { task: id, seconds: Math.round((Date.now() - started) / 1000) });

  const report = await invocation.readReport(result.stdout);

  const secret = SECRET.exec(report.trim());
  if (secret?.[1]) {
    if (spec.kind === "change") await pushWork(git, spec.title, startSha, branch);
    const names = secret[1].split(",").map((name) => name.trim());
    const why = secret[2]?.trim();
    return {
      kind: "blocked",
      question: `Set ${names.join(", ")} for ${spec.repo}${why ? `: ${why}` : "."}`,
      report,
      secrets: names,
    };
  }

  if (QUESTION.test(report)) {
    if (spec.kind === "change") await pushWork(git, spec.title, startSha, branch);
    return { kind: "blocked", question: report.replace(QUESTION, "").trim(), report };
  }

  if (spec.kind === "investigate") {
    return { kind: "completed", result: firstLine(report), report };
  }

  const pushed = await pushWork(git, spec.title, startSha, branch);
  if (!pushed && !resumed) return { kind: "completed", result: "No changes made.", report };
  const prUrl = await deps.openPullRequest({
    cwd: jobDir,
    github: repo.github,
    base,
    head: branch,
    title: spec.title,
    body: `${report}\n\n---\nJob #${id} by ${agent.name} on kiln · ${describeSelection(spec)} · ${deps.profile}`,
  });
  return { kind: "completed", result: `Draft PR: ${prUrl}`, report };
}

/** Writes what Claude Code reported about the subscription to its record, for the agent's next choice. */
async function recordUsage(
  deps: JobDeps,
  subscription: WorkerSubscription,
  watch: ClaudeWatch,
  model: string | undefined,
): Promise<void> {
  const latest = watch.latest;
  const exhausted = watch.exhausted;
  const labels = {
    ...(latest ? usageLabels(latest, model) : {}),
    ...(exhausted ? usageLabels(exhausted, model) : {}),
  };
  if (!subscription.record || Object.keys(labels).length === 0) return;
  try {
    await deps.board.label(subscription.record, { set: labels });
  } catch (error) {
    deps.log("job.usage_record_failed", { subscription: subscription.id, error: String(error) });
  }
}

/**
 * Keeps one bare mirror per repo in the work directory, so a job clones from
 * local objects instead of the network. The mirror never collects garbage,
 * because job clones borrow its objects.
 */
export async function refreshMirror(
  exec: Exec,
  mirror: string,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const fresh = (await exec("git", ["-C", mirror, "rev-parse", "--git-dir"])).code !== 0;
  if (fresh) {
    await rm(mirror, { recursive: true, force: true });
    await mkdir(dirname(mirror), { recursive: true });
    await run(exec, "git", ["clone", "--quiet", "--mirror", url, mirror], { signal });
    await run(exec, "git", ["-C", mirror, "config", "gc.auto", "0"], { signal });
  } else {
    await run(exec, "git", ["-C", mirror, "fetch", "--quiet", "--prune", "origin"], { signal });
  }
  return mirror;
}

/** Commits what the harness left uncommitted and pushes the branch. Returns whether it had new commits. */
async function pushWork(
  git: (args: readonly string[]) => Promise<string>,
  title: string,
  startSha: string,
  branch: string,
): Promise<boolean> {
  if ((await git(["status", "--porcelain"])) !== "") {
    await git(["add", "-A"]);
    await git(["commit", "--quiet", "-m", title]);
  }
  const ahead = Number(await git(["rev-list", "--count", `${startSha}..HEAD`]));
  if (ahead === 0) return false;
  // The branch belongs to this job, so overwriting it is safe.
  await git(["push", "--quiet", "--force", "-u", "origin", branch]);
  return true;
}

export function buildPrompt(
  spec: JobSpec,
  where: { readonly id: string; readonly github: string; readonly branch: string; readonly resumed: boolean },
  earlier: readonly { readonly text: string }[],
  guidance?: string,
): string {
  const lines = [
    `You are working on job #${where.id} from ${agent.name}, in a fresh clone of ${where.github}, on branch ${where.branch}.`,
    where.resumed ? "This branch holds work from an earlier run of this job; continue from it." : "",
    "",
    "# The job",
    "",
    `## ${spec.title}`,
    "",
    spec.brief,
    "",
  ];
  const notes = earlier.slice(-20).map((reply) => clip(reply.text, 2_000));
  if (notes.length > 0)
    lines.push("# Earlier in this job's thread", "", ...notes.map((note) => `- ${note}`), "");
  if (guidance?.trim()) lines.push("# House rules", "", guidance.trim(), "");
  lines.push("# How to work", "");
  if (spec.kind === "change") {
    lines.push(
      "- Make the change on this branch and commit it with clear messages.",
      "- Do not push, open a pull request, or switch branches. The worker pushes and opens a draft pull request after you finish.",
    );
  } else {
    lines.push("- Investigate and report. Do not commit, push, or open pull requests.");
  }
  lines.push(
    "- Run the checks that cover what you touched, when the repo has them.",
    `- To share files with the people who asked, such as screenshots, logs, or generated reports, save them in \`${ARTIFACTS_DIR}/\` at the repo root. They are attached to your report in Slack and never committed. Up to ${MAX_ARTIFACTS} files, ${MAX_ARTIFACT_MB} MB each.`,
    "- If you need a credential your environment doesn't have, such as an API key or a database URL, stop and make your final message `SECRET: ` followed by the environment variable names it should have and what for, like `SECRET: STRIPE_API_KEY: read the customer's payment history`. Never ask for a secret's value; people set it privately and the job resumes with it in your environment.",
    "- If you cannot go on without an answer from a person, stop and make your final message `QUESTION: ` followed by the question.",
    "- Otherwise your final message is the report people read in Slack: what you did or found, how you verified it, and what is left open. Under 400 words.",
  );
  return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n");
}

/** The report's first line as plain text: the job's one-line result. */
export function firstLine(report: string): string {
  const line = report.split("\n").find((candidate) => candidate.trim() !== "") ?? "Done.";
  return clip(
    line
      .replace(/^#+\s*/, "")
      .replace(/^\*\*(.*)\*\*$/, "$1")
      .trim() || "Done.",
    300,
  );
}

function tail(result: { readonly stdout: string; readonly stderr: string }): string {
  return (result.stderr.trim() ? result.stderr : result.stdout).slice(-LOG_TAIL_CHARS);
}

async function logTail(logFile: string): Promise<string> {
  try {
    return (await readFile(logFile, "utf8")).slice(-LOG_TAIL_CHARS);
  } catch {
    return "";
  }
}

async function settle(deps: JobDeps, outcome: Outcome, artifacts: readonly Artifact[] = []): Promise<void> {
  const { board, claim, log } = deps;
  const id = claim.task.id;
  try {
    if (outcome.kind === "abandoned") {
      if (outcome.why === SHUTDOWN) await claim.release();
      return;
    }
    if (outcome.kind === "waiting") {
      // Back to the queue: the agent starts it again, on the same model, when a subscription resets.
      await board.reply(id, `**Waiting for usage.** ${outcome.report}`);
      await board.label(id, { set: { [WAITING_LABEL]: String(outcome.until) }, unset: [ACCOUNT_LABEL] });
      await claim.release();
      return;
    }
    const attachments = [];
    for (const artifact of artifacts) {
      try {
        attachments.push(await board.upload({ data: artifact.bytes, name: artifact.name }));
      } catch (error) {
        log("job.artifact_failed", { task: id, file: artifact.name, error: String(error) });
      }
    }
    await board.reply(id, { text: replyText(outcome), ...(attachments.length ? { attachments } : {}) });
    await board.label(id, { set: { [REPORT_LABEL]: REPORT_PENDING } });
    if (outcome.kind === "completed") await claim.complete(clip(outcome.result, MAX_SETTLE_CHARS));
    else if (outcome.kind === "failed") await claim.fail(clip(outcome.reason, MAX_SETTLE_CHARS));
    else {
      if (outcome.secrets?.length) {
        await board.label(id, { set: { [NEEDS_SECRETS_LABEL]: outcome.secrets.join(",") } });
      }
      await claim.block(clip(outcome.question, MAX_SETTLE_CHARS), {
        kind: outcome.secrets?.length ? NEEDS_SECRET_KIND : "needs_input",
      });
    }
  } catch (error) {
    // Most often claim_lost: the lease ran out or the job was canceled while it ran.
    log("job.settle_failed", { task: id, outcome: outcome.kind, error: String(error) });
  }
}

function replyText(outcome: Exclude<Outcome, { kind: "abandoned" | "waiting" }>): string {
  switch (outcome.kind) {
    case "completed": {
      // An investigation's result is its report's first line; don't say it twice.
      const lead = outcome.report.includes(outcome.result) ? "**Done.**" : `**Done.** ${outcome.result}`;
      return clip(`${lead}\n\n${outcome.report}`, MAX_REPLY_CHARS);
    }
    case "failed":
      return clip(
        `**Failed:** ${outcome.reason}${outcome.report ? `\n\n\`\`\`\n${outcome.report}\n\`\`\`` : ""}`,
        MAX_REPLY_CHARS,
      );
    case "blocked":
      return clip(
        outcome.secrets?.length
          ? `**Paused for secrets:** ${outcome.question} The job resumes once they're set.`
          : `**Question:** ${outcome.question}`,
        MAX_REPLY_CHARS,
      );
  }
}
