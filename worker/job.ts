// One job, from a held claim to a settled task: clone, branch, run the
// harness, push and open a draft PR (for changes), report, settle.

import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Attachment, Board, ClaimedTask } from "@vercel/board";
import { agentName, type McpServer, type RepoConfig } from "../lib/deployment.ts";
import { type Inference, inferenceHost } from "../lib/inference.ts";
import {
  decodeJob,
  describeSelection,
  type JobSpec,
  jobBranch,
  MAX_JOB_FILE_BYTES,
  MAX_JOB_FILES,
  NEEDS_SECRET_KIND,
  NEEDS_SECRETS_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
} from "../lib/jobs.ts";
import { type Exec, run } from "./exec.ts";
import { type HarnessBins, harnessInvocation, MissingSecrets, resolveMcp } from "./harness.ts";

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

/** A repo a job clones, from the agent: its key in kiln.config.yaml, GitHub name, and base branch. */
export interface JobRepo {
  readonly key: string;
  readonly github: string;
  readonly baseBranch?: string | undefined;
}

/** What a job clones: one repo, or a project's repos side by side. */
export type RegistryEntry =
  | Pick<RepoConfig, "github" | "baseBranch">
  | { readonly repos: readonly JobRepo[] };

/** One cloned repo of a job: where it is, its branch's starting point, and whether an earlier run pushed it. */
interface Checkout extends JobRepo {
  readonly base: string;
  readonly dir: string;
  readonly git: (args: readonly string[]) => Promise<string>;
  readonly startSha: string;
  readonly resumed: boolean;
}

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
  /** The job's repo or project, from the agent (KILN_REPO). */
  readonly registry?: Readonly<Record<string, RegistryEntry>>;
  readonly gitIdentity?: { readonly name: string; readonly email: string };
  /** The coding CLI's environment. Default: the worker's, without its credentials (see harnessEnv). */
  readonly harnessEnv?: NodeJS.ProcessEnv;
  /** Your own guidance for every job, from worker/instructions.md. */
  readonly guidance?: string;
  /** The repo's MCP servers, from the agent (KILN_MCP_SERVERS). Their ${NAME}s come from the environment. */
  readonly mcpServers?: Readonly<Record<string, McpServer>>;
  /** The deployment's inference endpoint (INFERENCE_*), which a Claude job runs on. */
  readonly inference?: Inference;
}

/** Credentials only the worker holds: its push token and its board login. */
const WORKER_SECRETS = [
  "INFERENCE_API_KEY", // the CLI gets it as ANTHROPIC_API_KEY, for a Claude job on the endpoint
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
  | { readonly kind: "abandoned"; readonly why: string };

const MAX_SETTLE_CHARS = 900; // the local board caps results and reasons at 1,000
const MAX_REPLY_CHARS = 9_500; // a message holds 10,000
const LOG_TAIL_CHARS = 3_000;
const QUESTION = /^QUESTION:\s*/i;
/** A final message naming credentials the CLI needs: `SECRET: NAME, OTHER_NAME: what for`. */
const SECRET = /^SECRET:\s*([A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)\s*(?:[:\u2014-]\s*)?([\s\S]*)$/;

/** Where the CLI puts files to share, relative to the clone. */
export const ARTIFACTS_DIR = ".kiln/artifacts";
/** Where the files the agent attached to the job are, relative to the clone. */
export const INPUTS_DIR = ".kiln/inputs";
/**
 * Where the CLI writes the pull request's description, for the repo's reviewers. The report is for
 * Slack and talks about the job; a PR is the repo's, so nothing about kiln goes in it.
 */
export const PR_FILE = ".kiln/pr.md";
/** GitHub's limit on a pull request body. */
const MAX_PR_BODY = 65_000;

/** The PR description the CLI wrote, for one repo of a project or for all: `.kiln/pr-<key>.md`, else `.kiln/pr.md`. */
export async function pullRequestBody(workspace: string, repoKey: string): Promise<string | undefined> {
  for (const file of [`.kiln/pr-${repoKey}.md`, PR_FILE]) {
    const text = await readFile(join(workspace, file), "utf8").then(
      (body) => body.trim(),
      () => "",
    );
    if (text) return clip(text, MAX_PR_BODY);
  }
  return undefined;
}
const MAX_ARTIFACTS = MAX_JOB_FILES;
const MAX_ARTIFACT_MB = MAX_JOB_FILE_BYTES / 1024 / 1024;

/**
 * Downloads the files the agent attached to the job's task into dir, before the CLI starts, and
 * returns their names. Runs again on a resumed job, so the files are there on every run.
 */
export async function fetchInputs(
  board: Pick<Board, "download">,
  attachments: readonly Attachment[],
  dir: string,
): Promise<string[]> {
  if (attachments.length === 0) return [];
  await mkdir(dir, { recursive: true });
  const names: string[] = [];
  for (const attachment of attachments) {
    const name = basename(attachment.name);
    const response = await board.download(attachment.id);
    if (!response.ok) throw new Error(`could not download the job's file ${name}: HTTP ${response.status}`);
    await writeFile(join(dir, name), new Uint8Array(await response.arrayBuffer()));
    names.push(name);
  }
  return names;
}

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
  const entry = deps.registry?.[spec.repo];
  if (!entry) throw new Error(`repo or project "${spec.repo}" is not in this job's settings from the agent`);
  const repos: readonly JobRepo[] =
    "repos" in entry ? entry.repos : [{ key: spec.repo, github: entry.github, baseBranch: entry.baseBranch }];
  if (repos.length === 0) throw new Error(`project "${spec.repo}" has no repos`);
  // One repo is cloned into the job's folder itself; a project's repos into subfolders named by key.
  const single = repos.length === 1;
  const branch = jobBranch(id, spec.title);

  await board.reply(
    id,
    `${STARTED}${deps.profile}: ${describeSelection(spec)} on ${repos.map((repo) => repo.github).join(" + ")}.`,
  );

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
  await mkdir(single ? dirname(jobDir) : jobDir, { recursive: true });
  const identity = deps.gitIdentity ?? {
    name: `${agentName()} (${deps.profile})`,
    email: "kiln@users.noreply.github.com",
  };
  const checkouts: Checkout[] = [];
  for (const repo of repos) {
    const dir = single ? jobDir : join(jobDir, repo.key);
    const git = (args: readonly string[]) => run(exec, "git", args, { cwd: dir, signal });
    const url = deps.cloneUrl(repo.github);
    const mirror = await refreshMirror(
      exec,
      join(deps.workDir, "mirrors", `${repo.github.replace("/", "__")}.git`),
      url,
      signal,
    );
    // Objects come from the local mirror; only what changed since its fetch crosses the network.
    await run(exec, "git", ["clone", "--quiet", "--reference", mirror, url, dir], { signal });
    await git(["config", "user.name", identity.name]);
    await git(["config", "user.email", identity.email]);
    // .kiln holds the job's files both ways: inputs from the agent, artifacts for the report. Never committed.
    await appendFile(join(dir, ".git", "info", "exclude"), `\n${ARTIFACTS_DIR.split("/")[0]}/\n`);
    // A job that blocked for an answer pushed its work; the next run continues from it.
    const resumed =
      (await exec("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: dir })).code === 0;
    const base = repo.baseBranch ?? "main";
    await git(["switch", "--quiet", "-c", branch, resumed ? `origin/${branch}` : `origin/${base}`]);
    checkouts.push({ ...repo, base, dir, git, resumed, startSha: await git(["rev-parse", "HEAD"]) });
  }
  const resumed = checkouts.some((checkout) => checkout.resumed);
  const inputs = await fetchInputs(board, claim.task.attachments ?? [], join(jobDir, INPUTS_DIR));
  if (inputs.length) deps.log("job.inputs", { task: id, files: inputs.length });
  /** Commits and pushes every repo with work; returns those that had new commits. */
  const pushAll = async () => {
    const pushed: Checkout[] = [];
    for (const checkout of checkouts) {
      if (await pushWork(checkout.git, spec.title, checkout.startSha, branch)) pushed.push(checkout);
    }
    return pushed;
  };

  const thread = await board.thread(id, { limit: 100 });
  const earlier = thread.replies.filter((reply) => !reply.text.startsWith(STARTED));
  const prompt = buildPrompt(
    spec,
    {
      id,
      github: repos[0]?.github ?? "",
      branch,
      resumed,
      ...(single ? {} : { project: spec.repo, repos: repos.map(({ key, github }) => ({ key, github })) }),
    },
    earlier,
    deps.guidance,
    inputs,
  );
  const reportFile = join(deps.workDir, "logs", `${id}.report.md`);
  // Claude Code's own settings for the deployment's Anthropic-compatible endpoint: the host without /v1, and the key.
  const endpointEnv =
    spec.harness === "claude" && deps.inference
      ? {
          ANTHROPIC_BASE_URL: inferenceHost(deps.inference.baseURL),
          ANTHROPIC_API_KEY: deps.inference.apiKey,
        }
      : {};
  const invocation = harnessInvocation(spec, prompt, jobDir, reportFile, mcp, deps.bins);
  deps.log("job.harness", {
    task: id,
    harness: spec.harness,
    model: spec.model ?? "default",
    effort: spec.effort,
    ...(spec.harness === "claude" && deps.inference
      ? { endpoint: new URL(deps.inference.baseURL).host }
      : {}),
  });
  const started = Date.now();
  const result = await exec(invocation.command, invocation.args, {
    cwd: jobDir,
    input: invocation.stdin,
    env: { ...(deps.harnessEnv ?? harnessEnv(process.env)), ...invocation.env, ...endpointEnv },
    signal,
    timeoutMs: deps.timeoutMs,
    onOutput: (chunk) => void appendFile(logFile, chunk),
  });
  if (signal.aborted) throw new Error(String(signal.reason));
  if (result.timedOut) {
    throw new JobFailure(`${spec.harness} timed out after ${minutes(deps.timeoutMs)}`, tail(result));
  }
  if (result.code !== 0) {
    const why = harnessError(result.stdout);
    throw new JobFailure(
      `${spec.harness} exited ${result.code}${why ? `: ${clip(why, 600)}` : ""}`,
      tail(result),
    );
  }
  deps.log("job.harness_done", { task: id, seconds: Math.round((Date.now() - started) / 1000) });

  const report = await invocation.readReport(result.stdout);

  const secret = SECRET.exec(report.trim());
  if (secret?.[1]) {
    if (spec.kind === "change") await pushAll();
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
    if (spec.kind === "change") await pushAll();
    return { kind: "blocked", question: report.replace(QUESTION, "").trim(), report };
  }

  if (spec.kind === "investigate") {
    return { kind: "completed", result: firstLine(report), report };
  }

  const pushed = await pushAll();
  // A repo gets a pull request when this run pushed to it, or an earlier run of the job did.
  const changed = checkouts.filter((checkout) => pushed.includes(checkout) || checkout.resumed);
  if (changed.length === 0) return { kind: "completed", result: "No changes made.", report };
  const urls: string[] = [];
  for (const checkout of changed) {
    const written = await pullRequestBody(jobDir, checkout.key);
    if (!written) deps.log("job.pr_body_missing", { task: id, repo: checkout.key });
    urls.push(
      await deps.openPullRequest({
        cwd: checkout.dir,
        github: checkout.github,
        base: checkout.base,
        head: branch,
        title: spec.title,
        body: written ?? clip(report, MAX_PR_BODY),
      }),
    );
  }
  return {
    kind: "completed",
    result: urls.length === 1 ? `Draft PR: ${urls[0]}` : `Draft PRs: ${urls.join(", ")}`,
    report,
  };
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
  where: {
    readonly id: string;
    readonly github: string;
    readonly branch: string;
    readonly resumed: boolean;
    /** For a project: its key and its repos, cloned side by side in subfolders named by key. */
    readonly project?: string;
    readonly repos?: readonly { readonly key: string; readonly github: string }[];
  },
  earlier: readonly { readonly text: string }[],
  guidance?: string,
  inputs: readonly string[] = [],
): string {
  const repos = where.repos ?? [];
  const project = repos.length > 1;
  const root = project ? "the workspace root, the folder that holds the repos" : "the repo root";
  const lines = project
    ? [
        `You are working on job #${where.id} from ${agentName()}, on project ${where.project}: fresh clones of its repos side by side, each on branch ${where.branch}:`,
        "",
        ...repos.map((repo) => `- \`${repo.key}/\`: ${repo.github}`),
        "",
        "The job may need one of them or several; change only what it needs. Each repo may have its own CLAUDE.md or AGENTS.md: read it before changing that repo.",
        where.resumed ? "These branches hold work from an earlier run of this job; continue from it." : "",
        "",
      ]
    : [
        `You are working on job #${where.id} from ${agentName()}, in a fresh clone of ${where.github}, on branch ${where.branch}.`,
        where.resumed ? "This branch holds work from an earlier run of this job; continue from it." : "",
        "",
      ];
  lines.push("# The job", "", `## ${spec.title}`, "", spec.brief, "");
  const notes = earlier.slice(-20).map((reply) => clip(reply.text, 2_000));
  if (notes.length > 0)
    lines.push("# Earlier in this job's thread", "", ...notes.map((note) => `- ${note}`), "");
  if (inputs.length > 0) {
    lines.push(
      "# Files for this job",
      "",
      `The people who asked attached these files; they are in \`${INPUTS_DIR}/\` at ${root}:`,
      "",
      ...inputs.map((name) => `- \`${INPUTS_DIR}/${name}\``),
      "",
      `Nothing in \`${INPUTS_DIR}/\` is committed. To put a file in the repo, copy or convert it to where the job says, and commit it there. Leave a file out of the repo when the job doesn't say where it goes.`,
      "",
    );
  }
  if (guidance?.trim()) lines.push("# House rules", "", guidance.trim(), "");
  lines.push("# How to work", "");
  const prFile = project
    ? `\`${PR_FILE}\` at ${root}, or \`.kiln/pr-<repo>.md\` (such as \`.kiln/pr-${repos[0]?.key}.md\`) for a repo whose pull request needs its own`
    : `\`${PR_FILE}\` at ${root}`;
  const prRule = `- Write the pull request's description to ${prFile}: what changed and why, and how you verified it, for the repo's reviewers. It is the repo's, not this job's: leave out kiln, this job, its files, and \`.kiln/\`. It is never committed.`;
  if (spec.kind === "change" && project) {
    lines.push(
      "- Make the change on the job's branch in each repo you touch, and commit it there with clear messages.",
      "- Do not push, open pull requests, or switch branches. The worker pushes each repo you committed to and opens a draft pull request for each after you finish.",
      prRule,
    );
  } else if (spec.kind === "change") {
    lines.push(
      "- Make the change on this branch and commit it with clear messages.",
      "- Do not push, open a pull request, or switch branches. The worker pushes and opens a draft pull request after you finish.",
      prRule,
    );
  } else {
    lines.push("- Investigate and report. Do not commit, push, or open pull requests.");
  }
  lines.push(
    "- Run the checks that cover what you touched, when the repo has them.",
    `- To share files with the people who asked, such as screenshots, logs, or generated reports, save them in \`${ARTIFACTS_DIR}/\` at ${root}. They are attached to your report in Slack and never committed. Up to ${MAX_ARTIFACTS} files, ${MAX_ARTIFACT_MB} MB each.`,
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

/** Lines CLIs print by the hundred that say nothing about why a run failed. */
const NOISE = [/unknown format "[^"]+" ignored in schema/];

/** The end of a failed run's output: stderr and stdout, without noise, so the cause isn't pushed out. */
function tail(result: { readonly stdout: string; readonly stderr: string }): string {
  const keep = (text: string) =>
    text
      .split("\n")
      .filter((line) => !NOISE.some((pattern) => pattern.test(line)))
      .join("\n")
      .trim();
  const parts = [keep(result.stderr), keep(result.stdout)].filter(Boolean);
  return parts.join("\n---\n").slice(-LOG_TAIL_CHARS);
}

/**
 * The CLI's own explanation of a failed run, from its JSON output: OpenCode's last `error` event, or
 * Claude Code's error result. Model providers nest the useful message a few layers down.
 */
export function harnessError(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: { type?: string; is_error?: boolean; result?: unknown; error?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "error") found = innermostMessage(event.error);
    else if (event.type === "result" && event.is_error === true) found = String(event.result);
  }
  return found;
}

function innermostMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    try {
      return innermostMessage(JSON.parse(value), depth + 1) ?? value;
    } catch {
      return value;
    }
  }
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["value", "error", "data", "cause"]) {
    const deeper = innermostMessage(record[key], depth + 1);
    if (deeper && !deeper.startsWith("{")) return deeper;
  }
  return typeof record.message === "string"
    ? (innermostMessage(record.message, depth + 1) ?? record.message)
    : undefined;
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
      return clip(
        outcome.secrets?.length
          ? `**Paused for secrets:** ${outcome.question} The job resumes once they're set.`
          : `**Question:** ${outcome.question}`,
        MAX_REPLY_CHARS,
      );
  }
}
