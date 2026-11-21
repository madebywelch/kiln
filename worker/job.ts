// One job, from a held claim to a settled task: clone, branch, run the
// harness, push and open a draft PR (for changes), report, settle.

import { appendFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Board, ClaimedTask } from "@vercel/board";
import { type McpServer, mcpServers, type RepoConfig, repos } from "../lib/config.ts";
import {
  decodeJob,
  describeSelection,
  type JobSpec,
  jobBranch,
  REPORT_LABEL,
  REPORT_PENDING,
} from "../lib/jobs.ts";
import { type Exec, run } from "./exec.ts";
import { type HarnessBins, harnessInvocation, resolveMcp } from "./harness.ts";

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
  readonly registry?: Readonly<Record<string, RepoConfig>>;
  readonly gitIdentity?: { readonly name: string; readonly email: string };
  /** The coding CLI's environment. Default: the worker's, without its credentials (see harnessEnv). */
  readonly harnessEnv?: NodeJS.ProcessEnv;
  /** Your own guidance for every job, from worker/instructions.md. */
  readonly guidance?: string;
  /** MCP server definitions; repos pick from them. Default: lib/config.ts. */
  readonly mcpServers?: Readonly<Record<string, McpServer>>;
}

/** Credentials only the worker holds: its push token and its board login. */
const WORKER_SECRETS = [
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
  | { readonly kind: "blocked"; readonly question: string; readonly report: string }
  | { readonly kind: "abandoned"; readonly why: string };

const MAX_SETTLE_CHARS = 900; // the local board caps results and reasons at 1,000
const MAX_REPLY_CHARS = 9_500; // a message holds 10,000
const LOG_TAIL_CHARS = 3_000;
const QUESTION = /^QUESTION:\s*/i;

/** Where the CLI puts files to share, relative to the clone. */
export const ARTIFACTS_DIR = ".robdog/artifacts";
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

  const artifacts = outcome.kind === "abandoned" ? [] : await collectArtifacts(join(jobDir, ARTIFACTS_DIR));
  log("job.outcome", { task: id, outcome: outcome.kind, artifacts: artifacts.length });
  await settle(deps, outcome, artifacts);
  await rm(jobDir, { recursive: true, force: true });
  return outcome;
}

async function execute(deps: JobDeps, jobDir: string, logFile: string): Promise<Outcome> {
  const { board, claim, exec, signal } = deps;
  const id = claim.task.id;
  const spec = decodeJob(claim.task);
  const repo = (deps.registry ?? repos)[spec.repo];
  if (!repo) throw new Error(`repo "${spec.repo}" is not in this worker's registry; rebuild the worker`);
  const base = repo.baseBranch ?? "main";
  const branch = jobBranch(id, spec.title);
  const git = (args: readonly string[]) => run(exec, "git", args, { cwd: jobDir, signal });

  await board.reply(id, `${STARTED}${deps.profile}: ${describeSelection(spec)} on ${repo.github}.`);

  const mcp = resolveMcp(deps.mcpServers ?? mcpServers, repo.mcp ?? [], process.env);

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
    name: `robdog (${deps.profile})`,
    email: "robdog@users.noreply.github.com",
  };
  await git(["config", "user.name", identity.name]);
  await git(["config", "user.email", identity.email]);
  // Files the CLI shares go in .robdog/artifacts; they are attached to the report, never committed.
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
  const invocation = harnessInvocation(spec, prompt, jobDir, reportFile, mcp, deps.bins);

  deps.log("job.harness", {
    task: id,
    harness: spec.harness,
    model: spec.model ?? "default",
    effort: spec.effort,
  });
  const started = Date.now();
  const result = await exec(invocation.command, invocation.args, {
    cwd: jobDir,
    input: invocation.stdin,
    env: { ...(deps.harnessEnv ?? harnessEnv(process.env)), ...invocation.env },
    signal,
    timeoutMs: deps.timeoutMs,
    onOutput: (chunk) => void appendFile(logFile, chunk),
  });
  if (result.aborted) throw new Error(String(signal.reason));
  if (result.timedOut) {
    throw new JobFailure(`${spec.harness} timed out after ${minutes(deps.timeoutMs)}`, tail(result));
  }
  if (result.code !== 0) throw new JobFailure(`${spec.harness} exited ${result.code}`, tail(result));
  deps.log("job.harness_done", { task: id, seconds: Math.round((Date.now() - started) / 1000) });

  const report = await invocation.readReport(result.stdout);

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
    body: `${report}\n\n---\nJob #${id} by robdog · ${describeSelection(spec)} · ${deps.profile}`,
  });
  return { kind: "completed", result: `Draft PR: ${prUrl}`, report };
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
    `You are working on job #${where.id} from robdog, in a fresh clone of ${where.github}, on branch ${where.branch}.`,
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
    else await claim.block(clip(outcome.question, MAX_SETTLE_CHARS), { kind: "needs_input" });
  } catch (error) {
    // Most often claim_lost: the lease ran out or the job was canceled while it ran.
    log("job.settle_failed", { task: id, outcome: outcome.kind, error: String(error) });
  }
}

function replyText(outcome: Exclude<Outcome, { kind: "abandoned" }>): string {
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
      return clip(`**Question:** ${outcome.question}`, MAX_REPLY_CHARS);
  }
}
