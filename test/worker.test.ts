import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, board, type ClaimedTask } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answerJob, postJob, readJob } from "../lib/board-jobs.ts";
import type { McpServer, RepoConfig } from "../lib/deployment.ts";
import {
  artifactPath,
  BRANCH_LABEL,
  FULL_REPORT_FILE,
  INFERENCE_KIND,
  JOBS_CHANNEL,
  type JobSpec,
  jobRef,
  REPORT_LABEL,
  RESUME_LABEL,
  WAIT_MODEL_LABEL,
  WAIT_SINCE_LABEL,
  WAIT_UNTIL_LABEL,
} from "../lib/jobs.ts";
import { type Exec, exec } from "../worker/exec.ts";
import { claudeReport, harnessInvocation, opencodeReport, resolveMcp, topEffort } from "../worker/harness.ts";
import {
  buildPrompt,
  CLAIM_LOST,
  collectArtifacts,
  fetchInputs,
  firstLine,
  harnessEnv,
  harnessRateLimit,
  KEEP_AFTER_MS,
  type OpenPullRequest,
  type Outcome,
  type RegistryEntry,
  resumePrompt,
  runJob,
  SHUTDOWN,
  sinceLastRun,
} from "../worker/job.ts";
import { type Mask, secretMask } from "../worker/mask.ts";

const FAKE = join(import.meta.dirname, "fixtures", "fake-harness.mjs");
const registry: Record<string, RepoConfig> = { web: { github: "acme/web", description: "the website" } };

const spec: JobSpec = {
  repo: "web",
  kind: "change",
  title: "Add snow",
  brief: "Make it snow on the landing page.",
  harness: "claude",
  model: "opus",
  effort: "high",
  origin: { channelId: "C0123", threadTs: "1731712345.000100" },
};

let root: string;
let remote: string;
let team: Board;
let worker: Board;
let pullRequests: Parameters<OpenPullRequest>[0][];

const git = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

beforeAll(async () => {
  await chmod(FAKE, 0o755);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "kiln-worker-"));
  remote = join(root, "remote.git");
  git(["init", "--quiet", "--bare", "-b", "main", remote]);
  const seed = join(root, "seed");
  git(["clone", "--quiet", remote, seed]);
  await writeFile(join(seed, "README.md"), "# web\n");
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "init"], seed);
  git(["push", "--quiet", "origin", "HEAD:main"], seed);

  team = board({ backend: local({ memory: true }) });
  worker = team.as("claude-1");
  pullRequests = [];
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function claim(): Promise<ClaimedTask> {
  const claimed = await worker.tasks.claim({
    channel: JOBS_CHANNEL,
    label: { kiln: "job" },
    from: ["board:client"],
    lease: 300,
  });
  if (!claimed) throw new Error("nothing to claim");
  return claimed;
}

interface RunOptions {
  pushRetryDelaysMs?: readonly number[];
  mode: string;
  /** The machine's work directory: the same one again is the same machine, resumed. */
  workDir?: string;
  cloneUrl?: (github: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  registry?: Record<string, RegistryEntry>;
  harnessEnv?: NodeJS.ProcessEnv;
  guidance?: string;
  mcpServers?: Record<string, McpServer>;
  inference?: { baseURL: string; apiKey: string };
  mask?: Mask;
  sessionLogs?: string[];
}

interface Record_ {
  args: string[];
  stdin: string;
  head?: string;
  env: {
    GH_TOKEN: string | null;
    BOARD_TOKEN: string | null;
    OPENCODE_CONFIG_CONTENT?: string | null;
    ANTHROPIC_BASE_URL?: string | null;
    ANTHROPIC_API_KEY?: string | null;
    INFERENCE_API_KEY?: string | null;
    CLAUDE_CODE_OAUTH_TOKEN?: string | null;
  };
}

async function work(
  options: RunOptions,
): Promise<{ outcome: Outcome; record: Record_; runs: { args: string[]; token: string | null }[] }> {
  const recordFile = join(root, `record-${Math.random()}.json`);
  const fakeExec: Exec = (command, args, execOptions = {}) =>
    exec(command, args, {
      ...execOptions,
      env: { ...(execOptions.env ?? process.env), FAKE_MODE: options.mode, FAKE_RECORD: recordFile },
    });
  const outcome = await runJob({
    board: worker,
    claim: await claim(),
    profile: "claude-1",
    workDir: options.workDir ?? join(root, "work"),
    exec: fakeExec,
    bins: { claude: FAKE, codex: FAKE, opencode: FAKE },
    cloneUrl: options.cloneUrl ?? (() => remote),
    openPullRequest: async (input) => {
      pullRequests.push(input);
      return "https://github.com/acme/web/pull/7";
    },
    timeoutMs: options.timeoutMs ?? 30_000,
    signal: options.signal ?? new AbortController().signal,
    log: () => {},
    branchOwner: "octo",
    registry: options.registry ?? registry,
    ...(options.harnessEnv ? { harnessEnv: options.harnessEnv } : {}),
    ...(options.guidance ? { guidance: options.guidance } : {}),
    pushRetryDelaysMs: options.pushRetryDelaysMs ?? [],
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.inference ? { inference: options.inference } : {}),
    ...(options.mask ? { mask: options.mask } : {}),
    ...(options.sessionLogs ? { sessionLogs: options.sessionLogs } : {}),
  });
  let record: Record_ = { args: [], stdin: "", env: { GH_TOKEN: null, BOARD_TOKEN: null } };
  try {
    record = JSON.parse(await readFile(recordFile, "utf8"));
  } catch {
    // the harness never ran
  }
  let runs: { args: string[]; token: string | null }[] = [];
  try {
    runs = (await readFile(`${recordFile}.runs`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  } catch {
    // the harness never ran
  }
  return { outcome, record, runs };
}

async function rootOf(id: string) {
  return (await team.thread(id, { limit: 1 })).message;
}

/** The branch every job here gets: its owner, then its title ("Add snow"). Each test has a fresh remote. */
const BRANCH = "octo/add-snow";

function remoteFiles(branch: string): string[] {
  return git(["--git-dir", remote, "ls-tree", "-r", "--name-only", branch]).split("\n");
}

describe("failure paths", () => {
  it("fails a job whose repo the worker does not know", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "change", registry: {} });
    expect(outcome).toMatchObject({
      kind: "failed",
      reason: expect.stringContaining("not in this job's settings"),
    });
    const settled = await rootOf(job.id);
    expect(settled.task?.state).toBe("failed");
    expect(settled.labels[REPORT_LABEL]).toBe("pending");
  });

  it("fails a job whose harness exits non-zero, with the output tail in the log", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "fail" });
    expect(outcome).toMatchObject({ kind: "failed", reason: "claude exited 3" });
    const { job: view, log } = await readJob(team, job.id);
    expect(view.state).toBe("failed");
    expect(view.reason).toBe("claude exited 3");
    expect(log.at(-1)?.text).toContain("boom: rate limited");
  });

  it("fails a job whose harness reports an error", async () => {
    await postJob(team, spec);
    const { outcome } = await work({ mode: "claude-error" });
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("usage limit reached") });
  });

  it("fails a job that runs past its timeout", async () => {
    await postJob(team, spec);
    const { outcome } = await work({ mode: "hang", timeoutMs: 500 });
    expect(outcome).toMatchObject({ kind: "failed", reason: "claude timed out after 0m" });
  });

  it("abandons a job whose claim was lost, without settling it", async () => {
    const job = await postJob(team, spec);
    const lost = new AbortController();
    setTimeout(() => lost.abort(CLAIM_LOST), 300);
    const { outcome } = await work({ mode: "hang", signal: lost.signal });
    expect(outcome).toEqual({ kind: "abandoned", why: CLAIM_LOST });
    const root = await rootOf(job.id);
    expect(root.task?.state).toBe("claimed");
    expect(root.labels[REPORT_LABEL]).toBeUndefined();
  });

  it("hands a job back to the queue on shutdown", async () => {
    const job = await postJob(team, spec);
    const stop = new AbortController();
    setTimeout(() => stop.abort(SHUTDOWN), 300);
    const { outcome } = await work({ mode: "hang", signal: stop.signal });
    expect(outcome).toEqual({ kind: "abandoned", why: SHUTDOWN });
    expect((await rootOf(job.id)).task?.state).toBe("ready");
  });
});

describe("branch names", () => {
  it("names the branch for its owner and title, and labels the job with it for later runs", async () => {
    const job = await postJob(team, spec);
    await work({ mode: "change" });
    expect((await rootOf(job.id)).labels[BRANCH_LABEL]).toBe(BRANCH);
    expect(remoteFiles(BRANCH)).toContain("theme.css");
  });

  it("adds the job's reference when the name is someone else's branch, and leaves theirs alone", async () => {
    git(["--git-dir", remote, "branch", BRANCH, "main"]);
    const before = git(["--git-dir", remote, "rev-parse", BRANCH]);
    const job = await postJob(team, spec);
    await work({ mode: "change" });
    const branch = `${BRANCH}-${jobRef(job.id)}`;
    expect((await rootOf(job.id)).labels[BRANCH_LABEL]).toBe(branch);
    expect(remoteFiles(branch)).toContain("theme.css");
    expect(git(["--git-dir", remote, "rev-parse", BRANCH])).toBe(before);
  });

  it("keeps the branch a job was labeled with, even when its title would name another", async () => {
    const job = await postJob(team, spec);
    await team.label(job.id, { set: { [BRANCH_LABEL]: "octo/earlier-name" } });
    await work({ mode: "change" });
    expect(remoteFiles("octo/earlier-name")).toContain("theme.css");
    expect(() => remoteFiles(BRANCH)).toThrow();
  });
});

describe("pushing", () => {
  /** Makes the remote refuse the next `times` pushes, as GitHub does now and then with "(failed)". */
  function refusePushes(times: number) {
    const count = join(root, "refused");
    writeFileSync(
      join(remote, "hooks", "pre-receive"),
      `#!/bin/sh\nn=$(cat ${count} 2>/dev/null || echo 0)\nif [ "$n" -lt ${times} ]; then echo $((n + 1)) > ${count}; echo refused >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );
  }

  it("retries a refused push and completes", async () => {
    refusePushes(1);
    await postJob(team, spec);
    const { outcome } = await work({ mode: "change", pushRetryDelaysMs: [0, 0] });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(BRANCH)).toContain("theme.css");
  });

  it("fails with git's error once the retries run out", async () => {
    refusePushes(3);
    await postJob(team, spec);
    const { outcome } = await work({ mode: "change", pushRetryDelaysMs: [0, 0] });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(JSON.stringify(outcome)).toContain("pre-receive hook declined");
  });
});

describe("change jobs", () => {
  it("commits, pushes the job's branch, opens a draft PR, and completes", async () => {
    const job = await postJob(team, spec);
    const { outcome, record } = await work({ mode: "change" });
    const branch = BRANCH;

    expect(outcome).toMatchObject({
      kind: "completed",
      result: "Draft PR: https://github.com/acme/web/pull/7",
    });
    expect(record.args).toEqual(
      expect.arrayContaining([
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "opus",
        "--effort",
        "high",
      ]),
    );
    expect(record.stdin).toContain("Make it snow on the landing page.");
    expect(record.stdin).toContain(`on branch ${branch}`);
    expect(remoteFiles(branch)).toContain("theme.css");
    expect(git(["--git-dir", remote, "log", "-1", "--format=%s", branch])).toBe("Add snow");
    expect(pullRequests).toEqual([
      expect.objectContaining({ github: "acme/web", base: "main", head: branch, title: "Add snow" }),
    ]);
    expect(pullRequests[0]?.body).toContain("Added snow to the landing page.");

    const { job: view, log } = await readJob(team, job.id);
    expect(view.state).toBe("completed");
    expect(view.result).toBe("Draft PR: https://github.com/acme/web/pull/7");
    expect(log.map((entry) => entry.text)).toEqual([
      expect.stringMatching(/^Started by claude-1: claude opus\/high on acme\/web/),
      expect.stringMatching(/^\*\*Done\.\*\* Draft PR/),
    ]);
    expect((await rootOf(job.id)).labels[REPORT_LABEL]).toBe("pending");
  });

  it("keeps commits the harness made itself", async () => {
    const job = await postJob(team, spec);
    await work({ mode: "commit" });
    const branch = BRANCH;
    expect(git(["--git-dir", remote, "log", "-1", "--format=%s", branch])).toBe("Add snow");
    expect(pullRequests).toHaveLength(1);
  });

  it("completes without a PR when nothing changed", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "nothing" });
    expect(outcome).toMatchObject({ kind: "completed", result: "No changes made." });
    expect(pullRequests).toEqual([]);
    expect(() => remoteFiles(BRANCH)).toThrow();
  });

  it("blocks on a question, keeps the work on its machine unpushed, and continues the session with the answer", async () => {
    const job = await postJob(team, spec);
    const first = await work({ mode: "question" });
    expect(first.outcome).toMatchObject({ kind: "blocked", question: "Which colors should the theme use?" });
    const branch = BRANCH;
    expect(() => remoteFiles(branch)).toThrow(); // nothing unfinished reaches GitHub
    await expect(stat(join(root, "work", "jobs", job.id, "draft.css"))).resolves.toBeDefined();
    const blocked = await rootOf(job.id);
    expect(blocked.task?.state).toBe("blocked");
    expect(blocked.task?.blocked).toEqual({
      kind: "needs_input",
      reason: "Which colors should the theme use?",
    });
    expect(blocked.labels[RESUME_LABEL]).toBe("ses-claude-1");

    await answerJob(team, job.id, "Red and green.");
    const second = await work({ mode: "change" });
    expect(second.record.args).toEqual(expect.arrayContaining(["--resume", "ses-claude-1"]));
    expect(second.record.stdin).toContain("resumed on the same machine");
    expect(second.record.stdin).toContain("**Question:** Which colors should the theme use?");
    expect(second.record.stdin).toContain("Red and green.");
    expect(second.record.stdin).not.toContain("Started by");
    expect(second.record.stdin).not.toContain(spec.brief); // the session already has it
    expect(second.outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(branch)).toEqual(expect.arrayContaining(["draft.css", "theme.css"]));
    expect((await rootOf(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
  });

  it("starts over from the brief and the thread when the kept machine is gone", async () => {
    const job = await postJob(team, spec);
    await work({ mode: "question" });
    await answerJob(team, job.id, "Red and green.");
    const second = await work({ mode: "change", workDir: join(root, "other-machine") });
    expect(second.record.args).not.toContain("--resume");
    expect(second.record.stdin).toContain(spec.brief);
    expect(second.record.stdin).toContain("Red and green.");
    expect(second.outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(BRANCH)).not.toContain("draft.css");
  });
});

describe("project jobs", () => {
  // A second repo, so a project job clones two side by side.
  async function secondRemote(): Promise<string> {
    const cloud = join(root, "cloud.git");
    git(["init", "--quiet", "--bare", "-b", "main", cloud]);
    const seed = join(root, "cloud-seed");
    git(["clone", "--quiet", cloud, seed]);
    await writeFile(join(seed, "README.md"), "# cloud\n");
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "init"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);
    return cloud;
  }
  const project = {
    shop: {
      repos: [
        { key: "web", github: "acme/web" },
        { key: "cloud", github: "acme/cloud" },
      ],
    },
  };
  const shopSpec = { ...spec, repo: "shop" };

  it("clones every repo side by side and opens a draft PR for each one it changed", async () => {
    const cloud = await secondRemote();
    const job = await postJob(team, shopSpec);
    const { outcome, record } = await work({
      mode: "project",
      registry: project,
      cloneUrl: (github) => (github === "acme/cloud" ? cloud : remote),
    });
    expect(record.stdin).toContain("on project shop: fresh clones of its repos side by side");
    expect(record.stdin).toContain("- `web/`: acme/web");
    expect(record.stdin).toContain("- `cloud/`: acme/cloud");
    expect(record.stdin).toContain("opens a draft pull request for each");
    const branch = BRANCH;
    expect(remoteFiles(branch)).toContain("theme.css");
    expect(git(["--git-dir", cloud, "ls-tree", "-r", "--name-only", branch]).split("\n")).toContain(
      "theme.css",
    );
    expect(pullRequests.map((pr) => pr.github).sort()).toEqual(["acme/cloud", "acme/web"]);
    const bodies = Object.fromEntries(pullRequests.map((pr) => [pr.github, pr.body]));
    expect(bodies).toEqual({ "acme/cloud": "Snow in cloud.", "acme/web": "Snow across the shop." });
    expect(record.stdin).toContain("`.kiln/pr-<repo>.md`");
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(outcome.kind === "completed" && outcome.result).toMatch(/^Draft PRs: /);
  });

  it("opens a PR only for the repo it changed, and leaves the other untouched", async () => {
    const cloud = await secondRemote();
    const job = await postJob(team, shopSpec);
    const { outcome } = await work({
      mode: "project-one",
      registry: project,
      cloneUrl: (github) => (github === "acme/cloud" ? cloud : remote),
    });
    const branch = BRANCH;
    expect(pullRequests.map((pr) => pr.github)).toEqual(["acme/web"]);
    expect(() => git(["--git-dir", cloud, "rev-parse", "--verify", branch])).toThrow();
    expect(outcome.kind === "completed" && outcome.result).toBe(
      "Draft PR: https://github.com/acme/web/pull/7",
    );
  });
});

describe("pull request descriptions", () => {
  it("uses the description the CLI wrote for reviewers, not its Slack report, and adds nothing about kiln", async () => {
    await postJob(team, spec);
    const { record } = await work({ mode: "pr-file" });
    expect(record.stdin).toContain("Write the pull request's description to `.kiln/pr.md`");
    expect(record.stdin).toContain("leave out kiln, this job, its files, and `.kiln/`");
    // A reviewer's description, not the job's whole story: capped, with the rest sent to the report.
    expect(record.stdin).toContain("for a reviewer deciding whether to merge");
    expect(record.stdin).toContain("Under 250 words.");
    expect(record.stdin).toContain("goes in your report");
    expect(pullRequests).toHaveLength(1);
    expect(pullRequests[0]?.body).toBe(
      "## Snow on the landing page\n\nAdds a snow layer. Verified with the unit tests.",
    );
  });

  it("falls back to the report when the CLI wrote no description, still with no kiln footer", async () => {
    await postJob(team, spec);
    await work({ mode: "change" });
    expect(pullRequests[0]?.body).toBe("Added snow to the landing page.\n\nVerified with the unit tests.");
    expect(pullRequests[0]?.body).not.toMatch(/kiln|Job #/);
  });
});

describe("the inference endpoint", () => {
  it("runs a Claude job on the endpoint, with Claude Code's own settings", async () => {
    await postJob(team, spec);
    const { outcome, record } = await work({
      mode: "change",
      harnessEnv: harnessEnv({ ...process.env, INFERENCE_API_KEY: "sk-endpoint", GH_TOKEN: "ghp_write" }),
      inference: { baseURL: "https://llm.example.com/v1/", apiKey: "sk-endpoint" },
    });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(record.env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://llm.example.com",
      ANTHROPIC_API_KEY: "sk-endpoint",
      CLAUDE_CODE_OAUTH_TOKEN: null,
      INFERENCE_API_KEY: null,
      GH_TOKEN: null,
    });
  });
});

describe("credentials", () => {
  const workerEnv = { ...process.env, GH_TOKEN: "ghp_write", BOARD_TOKEN: "board_secret" };

  it("keeps the worker's push token and board login from the coding CLI, and still pushes", async () => {
    const job = await postJob(team, spec);
    const { outcome, record } = await work({ mode: "change", harnessEnv: harnessEnv(workerEnv) });
    expect(record.env).toMatchObject({ GH_TOKEN: null, BOARD_TOKEN: null });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(BRANCH)).toContain("theme.css");
  });

  it("gives the coding CLI the read-only token as its GH_TOKEN", async () => {
    await postJob(team, spec);
    const { record } = await work({ mode: "nothing", harnessEnv: harnessEnv(workerEnv, "ghp_read") });
    expect(record.env).toMatchObject({ GH_TOKEN: "ghp_read", BOARD_TOKEN: null });
  });
});

describe("investigate jobs on codex", () => {
  it("reports without pushing, at codex's top effort for max", async () => {
    const job = await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "codex",
      model: undefined,
      effort: "max",
    });
    const { outcome, record } = await work({ mode: "change" });
    expect(outcome).toMatchObject({ kind: "completed", result: "Added snow to the landing page." });
    expect(record.args[0]).toBe("exec");
    expect(record.args).toEqual(expect.arrayContaining(["-c", 'model_reasoning_effort="xhigh"', "-"]));
    expect(record.args).not.toContain("-m");
    expect(record.stdin).toContain("Do not commit, push, or open pull requests.");
    expect(pullRequests).toEqual([]);
    expect(() => remoteFiles(BRANCH)).toThrow();
    const { log } = await readJob(team, job.id);
    expect(log.at(-1)?.text).toBe(
      "**Done.**\n\nAdded snow to the landing page.\n\nVerified with the unit tests.",
    );
  });
});

describe("result lines", () => {
  it("reads a report's first line as plain text", () => {
    expect(firstLine("\n## Christmas prep status\n\nbody")).toBe("Christmas prep status");
    expect(firstLine("**Found three issues**\nmore")).toBe("Found three issues");
    expect(firstLine("")).toBe("Done.");
  });
});

describe("artifacts", () => {
  it("attaches the files the CLI left to share, and never commits them", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "artifact" });
    expect(outcome).toMatchObject({
      kind: "completed",
      result: "Draft PR: https://github.com/acme/web/pull/7",
    });
    const files = remoteFiles(BRANCH);
    expect(files).toContain("theme.css");
    expect(files.some((file) => file.startsWith(".kiln"))).toBe(false);
    const { replies } = await team.thread(job.id, { limit: 10 });
    const report = replies.at(-1);
    expect(report?.attachments.map((attachment) => attachment.name)).toEqual(["home.png"]);
    const bytes = new Uint8Array(await (await team.download(report!.attachments[0]!.id)).arrayBuffer());
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("attaches a report too long for the job update whole, ahead of the CLI's files", async () => {
    const job = await postJob(team, { ...spec, kind: "investigate" });
    const { outcome } = await work({ mode: "long-report" });
    expect(outcome).toMatchObject({ kind: "completed" });
    const report = (await team.thread(job.id, { limit: 10 })).replies.at(-1);
    expect(report?.attachments.map((attachment) => attachment.name)).toEqual([FULL_REPORT_FILE]);
    const text = await (await team.download(report!.attachments[0]!.id)).text();
    expect(text.endsWith("The proposal is at the end.")).toBe(true);
  });

  it("tells the CLI to return files only when asked or when people must see them, never logs", async () => {
    await postJob(team, spec);
    const { record } = await work({ mode: "nothing" });
    expect(record.stdin).toContain("only when the brief asks for one, or when people must see it");
    expect(record.stdin).toContain("Never save logs, test output, or machine-readable reports there");
  });

  it("hands the CLI the agent's files in .kiln/inputs, and commits one only where the CLI puts it", async () => {
    const favicon = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0xff, 0x7f]);
    const job = await postJob(team, { ...spec, brief: "Put favicon.ico at public/favicon.ico." }, [
      { name: "favicon.ico", bytes: favicon },
    ]);
    const { outcome, record } = await work({ mode: "place-input" });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(record.stdin).toContain("# Files for this job");
    expect(record.stdin).toContain("`.kiln/inputs/favicon.ico`");
    const branch = BRANCH;
    const files = remoteFiles(branch);
    expect(files).toContain("public/favicon.ico");
    expect(files.some((file) => file.startsWith(".kiln"))).toBe(false);
    const committed = execFileSync("git", ["--git-dir", remote, "show", `${branch}:public/favicon.ico`]);
    expect([...committed]).toEqual([...favicon]);
  });

  it("downloads nothing for a job without files, and says nothing about them", async () => {
    const dir = join(root, "inputs");
    expect(await fetchInputs(team, [], dir)).toEqual([]);
    await expect(stat(dir)).rejects.toThrow();
    await postJob(team, spec);
    const { record } = await work({ mode: "nothing" });
    expect(record.stdin).not.toContain("# Files for this job");
  });

  it("fails the job, before the CLI runs, when a file can't be downloaded", async () => {
    const broken = { download: async () => new Response("gone", { status: 404 }) };
    await expect(
      fetchInputs(broken, [{ id: "att_1", name: "logo.svg" } as never], join(root, "inputs")),
    ).rejects.toThrow(/could not download the job's file logo.svg: HTTP 404/);
  });

  it("takes at most ten files, names the rest and any too large, and nothing from a missing folder", async () => {
    const dir = join(root, "artifacts");
    await mkdir(join(dir, "deep"), { recursive: true });
    for (let index = 0; index < 11; index++)
      await writeFile(join(dir, `f${String(index).padStart(2, "0")}.txt`), "x");
    await writeFile(join(dir, "deep", "huge.bin"), "");
    await truncate(join(dir, "deep", "huge.bin"), 26 * 1024 * 1024);
    const { artifacts, skipped } = await collectArtifacts(dir);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`),
    );
    expect(skipped).toEqual(["deep/huge.bin (over 25 MB)", "f10.txt (over the 10-file limit)"]);
    expect(await collectArtifacts(join(root, "nowhere"))).toEqual({ artifacts: [], skipped: [] });
  });

  it("returns files from subfolders under their paths, archives too", async () => {
    const job = await postJob(team, { ...spec, kind: "investigate" });
    await work({ mode: "nested-artifacts" });
    const report = (await team.thread(job.id, { limit: 10 })).replies.at(-1);
    const names = report?.attachments.map((attachment) => attachment.name) ?? [];
    expect(names.map(artifactPath)).toEqual(["trial/data.tar.gz", "trial/report.md"]);
    expect(report?.text).not.toContain("Files not attached");
  });

  it("names in the update the files it couldn't send", async () => {
    const job = await postJob(team, { ...spec, kind: "investigate" });
    await work({ mode: "long-report-many-files" });
    const report = (await team.thread(job.id, { limit: 10 })).replies.at(-1);
    expect(report?.attachments).toHaveLength(10);
    expect(report?.text).toMatch(/\*\*Files not attached:\*\* x09\.txt \(over the 10-file limit\)\./);
  });
});

describe("secrets in a job's output", () => {
  const DB_URL = "postgres://reader:s3cret-Passw0rd@db.internal:5432/app";
  const secretRun = () => {
    const env = { ...process.env, DB_URL };
    return { harnessEnv: env, mask: secretMask(env, ["DB_URL"]) };
  };

  it("hides a printed secret in the update, the returned files, the logs, and the CLI's session, and says so", async () => {
    const job = await postJob(team, { ...spec, kind: "investigate" });
    const sessions = join(root, "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "s.jsonl"), `{"text":"${DB_URL}"}\n`);
    const workDir = join(root, "work");
    await work({ mode: "print-secret", workDir, sessionLogs: [sessions], ...secretRun() });
    const report = (await team.thread(job.id, { limit: 10 })).replies.at(-1);
    expect(report?.text).not.toContain("s3cret-Passw0rd");
    expect(report?.text).toContain("Could not parse [DB_URL hidden].");
    expect(report?.text).toMatch(/^\*\*Secrets hidden:\*\* the value of DB_URL appeared/);
    const notes = await (await team.download(report?.attachments[0]?.id ?? "")).text();
    expect(notes).toBe("url was [DB_URL hidden]\n");
    expect(await readFile(join(sessions, "s.jsonl"), "utf8")).toBe('{"text":"[DB_URL hidden]"}\n');
    for (const name of await readdir(join(workDir, "logs")))
      expect(await readFile(join(workDir, "logs", name), "utf8")).not.toContain("s3cret-Passw0rd");
  });

  it("refuses to push commits that hold a secret, naming it but not its value", async () => {
    await postJob(team, spec);
    const { outcome } = await work({ mode: "commit-secret", ...secretRun() });
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(outcome.kind === "failed" && outcome.reason).toMatch(
      /commits hold the value of DB_URL, so nothing was pushed/,
    );
    expect(() => remoteFiles(BRANCH)).toThrow();
    expect(pullRequests).toEqual([]);
  });

  it("adds no note when nothing was hidden", async () => {
    const job = await postJob(team, { ...spec, kind: "investigate" });
    await work({ mode: "nested-artifacts", ...secretRun() });
    const report = (await team.thread(job.id, { limit: 10 })).replies.at(-1);
    expect(report?.text).not.toContain("Secrets hidden");
  });
});

describe("opencode jobs on AI Gateway", () => {
  it("runs the gateway model at the job's effort and reads its last message", async () => {
    await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "deepseek/deepseek-v4.1-flash",
      effort: "max",
    });
    const { outcome, record } = await work({ mode: "change" });
    expect(record.args.slice(0, 4)).toEqual(["run", "--format", "json", "--auto"]);
    expect(record.args).toEqual(
      expect.arrayContaining(["-m", "vercel/deepseek/deepseek-v4.1-flash", "--variant", "xhigh"]),
    );
    expect(record.stdin).toContain("Make it snow on the landing page.");
    expect(outcome).toMatchObject({
      kind: "completed",
      report: "Added snow to the landing page.\n\nVerified with the unit tests.",
    });
  });
});

describe("the repo mirror", () => {
  it("clones from a local mirror and still sees what was pushed since", async () => {
    await postJob(team, { ...spec, kind: "investigate" });
    const first = await work({ mode: "nothing" });
    const mirror = join(root, "work", "mirrors", "acme__web.git");
    expect(git(["-C", mirror, "rev-parse", "--is-bare-repository"])).toBe("true");
    expect(first.record.head).toBe(git(["--git-dir", remote, "rev-parse", "main"]));

    const seed = join(root, "seed");
    await writeFile(join(seed, "NEWS.md"), "new\n");
    git(["add", "-A"], seed);
    git(["commit", "--quiet", "-m", "news"], seed);
    git(["push", "--quiet", "origin", "HEAD:main"], seed);

    await postJob(team, { ...spec, kind: "investigate", title: "Again" });
    const second = await work({ mode: "nothing" });
    expect(second.record.head).toBe(git(["--git-dir", remote, "rev-parse", "main"]));
    expect(second.record.head).not.toBe(first.record.head);
  });
});

describe("house rules and MCP servers", () => {
  it("puts your guidance in every prompt", async () => {
    await postJob(team, spec);
    const { record } = await work({ mode: "nothing", guidance: "Always write tests first." });
    expect(record.stdin).toContain("# House rules\n\nAlways write tests first.");
  });

  it("gives a job the MCP servers the agent sent, with secrets from the worker's environment", async () => {
    process.env.TEST_LINEAR_KEY = "lin_secret";
    const servers: Record<string, McpServer> = {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TEST_LINEAR_KEY}" } },
    };
    await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    const { record } = await work({ mode: "nothing", mcpServers: servers });
    expect(JSON.parse(record.env.OPENCODE_CONFIG_CONTENT ?? "{}")).toEqual({
      mcp: {
        linear: {
          type: "remote",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer lin_secret" },
          enabled: true,
        },
      },
    });
    delete process.env.TEST_LINEAR_KEY;
  });

  it("pauses a job whose MCP servers need a secret the repo lacks, before running anything", async () => {
    const servers: Record<string, McpServer> = {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TEST_MISSING_KEY}" } },
    };
    const job = await postJob(team, spec);
    const { outcome, runs } = await work({ mode: "change", mcpServers: servers });
    expect(outcome).toMatchObject({ kind: "blocked", secrets: ["TEST_MISSING_KEY"] });
    expect(runs).toEqual([]);
    const root = await rootOf(job.id);
    expect(root.task?.state).toBe("blocked");
    expect(root.labels.needs_secrets).toBe("TEST_MISSING_KEY");
    expect(root.labels[REPORT_LABEL]).toBe("pending");
    const { log } = await readJob(team, job.id);
    expect(log.at(-1)?.text).toMatch(/^\*\*Paused for secrets:\*\* Set TEST_MISSING_KEY for web/);
  });

  it("pauses a job whose CLI ends asking for a secret by name, with its work kept on its machine", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "secret" });
    expect(outcome).toMatchObject({
      kind: "blocked",
      secrets: ["STRIPE_API_KEY", "DATABASE_URL"],
      question: "Set STRIPE_API_KEY, DATABASE_URL for web: read the customer's payment history",
    });
    const root_ = await rootOf(job.id);
    expect(root_.labels.needs_secrets).toBe("STRIPE_API_KEY,DATABASE_URL");
    expect(root_.labels[RESUME_LABEL]).toBe("ses-claude-1");
    await expect(stat(join(root, "work", "jobs", job.id, "draft.css"))).resolves.toBeDefined();
  });

  it("tells the CLI to name a missing credential, never to ask for its value", () => {
    const prompt = buildPrompt(spec, { id: "1", github: "acme/web", branch: "kiln/1-x", resumed: false }, []);
    expect(prompt).toContain("`SECRET: `");
    expect(prompt).toContain("Never ask for a secret's value");
  });
});

describe("harness adapters", () => {
  it("reads claude's JSON result and refuses anything else", () => {
    expect(claudeReport('noise\n{"result":"  hi  ","is_error":false}\n')).toBe("hi");
    expect(() => claudeReport("not json")).toThrow(/no JSON result/);
    expect(() => claudeReport('{"result":"quota","is_error":true}')).toThrow(/quota/);
    expect(() => claudeReport('{"is_error":false}')).toThrow(/no text/);
    // A background command finishing after the final message starts a short extra turn: both stay.
    const turns = [
      { type: "result", is_error: false, result: "Fixed the flaky test.\n\nValue to apply: 42." },
      {
        type: "result",
        is_error: false,
        result: "That was my wait loop timing out. The report above stands.",
      },
    ];
    expect(claudeReport(turns.map((t) => JSON.stringify(t)).join("\n"))).toBe(
      "Fixed the flaky test.\n\nValue to apply: 42.\n\nThat was my wait loop timing out. The report above stands.",
    );
  });

  it("reads opencode's last message and refuses errors and silence", () => {
    const text = (messageID: string, value: string) =>
      JSON.stringify({ type: "text", part: { messageID, text: value } });
    expect(
      opencodeReport([text("a", "thinking"), text("b", "fin"), text("b", "al"), "noise"].join("\n")),
    ).toBe("final");
    expect(() => opencodeReport(JSON.stringify({ type: "error", error: { message: "no credits" } }))).toThrow(
      /no credits/,
    );
    expect(() => opencodeReport("")).toThrow(/no final message/);
  });

  it("omits the model flag when the CLI picks the model", () => {
    const claude = harnessInvocation({ harness: "claude", model: undefined, effort: "max" }, "p", "/w", "/r");
    expect(claude.args).not.toContain("--model");
    expect(claude.args).toEqual(expect.arrayContaining(["--effort", "max"]));
    expect(claude.stdin).toBe("p");
  });

  it("maps efforts codex and opencode lack", () => {
    expect(topEffort("max")).toBe("xhigh");
    expect(topEffort("low")).toBe("low");
  });

  it("hands each CLI its MCP servers in its own format", () => {
    const mcp = resolveMcp(
      {
        docs: { url: "https://docs.example/mcp", headers: { "X-Key": "${TEST_DOCS_KEY}" } },
        local: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "${TEST_DOCS_KEY}" } },
      },
      ["docs", "local"],
      { TEST_DOCS_KEY: "k1" },
    );
    const selection = { model: undefined, effort: "high" } as const;
    const claude = harnessInvocation({ ...selection, harness: "claude" }, "p", "/w", "/r", mcp);
    expect(JSON.parse(claude.args[claude.args.indexOf("--mcp-config") + 1] ?? "")).toEqual({
      mcpServers: {
        docs: { type: "http", url: "https://docs.example/mcp", headers: { "X-Key": "k1" } },
        local: { type: "stdio", command: "npx", args: ["-y", "srv"], env: { TOKEN: "k1" } },
      },
    });
    const codex = harnessInvocation({ ...selection, harness: "codex" }, "p", "/w", "/r", mcp);
    expect(codex.args).toEqual(
      expect.arrayContaining([
        'mcp_servers.docs.url="https://docs.example/mcp"',
        'mcp_servers.docs.http_headers={ "X-Key" = "k1" }',
        'mcp_servers.local.command="npx"',
        'mcp_servers.local.args=["-y","srv"]',
        'mcp_servers.local.env={ "TOKEN" = "k1" }',
      ]),
    );
    expect(() => resolveMcp({}, ["ghost"], {})).toThrow(/not defined/);
  });

  it("turns off Claude Code's co-author trailer and PR attribution on every run", () => {
    const where = harnessInvocation(spec, "p", "/tmp/x", "/tmp/r");
    const settings = where.args[where.args.indexOf("--settings") + 1];
    expect(JSON.parse(settings ?? "{}")).toEqual({
      attribution: { commit: "", pr: "" },
      includeCoAuthoredBy: false,
    });
  });

  it("writes a prompt that says how to finish for each kind", () => {
    const where = { id: "1", github: "acme/web", branch: "kiln/1", resumed: false };
    expect(buildPrompt(spec, where, [])).toContain("The worker pushes and opens a draft pull request");
    expect(buildPrompt({ ...spec, kind: "investigate" }, where, [])).toContain("Investigate and report.");
    expect(buildPrompt(spec, where, [])).toContain("QUESTION: ");
  });
});

describe("failure reports", () => {
  it("names the CLI's own error, dug out of its JSON, past hundreds of noise lines", async () => {
    await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    const { outcome } = await work({ mode: "noisy-fail" });
    expect(outcome).toMatchObject({
      kind: "failed",
      reason:
        "opencode exited 1: Invalid JSON schema: regex lookaround is not supported. Found at $.properties.email.pattern.",
    });
    expect(outcome.kind === "failed" && outcome.report).not.toContain("unknown format");
  });
});

describe("waiting for inference", () => {
  it("pauses a job the endpoint rate limits, quietly, with its work and session kept until the reset", async () => {
    const job = await postJob(team, spec);
    const before = Date.now();
    const { outcome } = await work({ mode: "rate-limited" });
    expect(outcome).toMatchObject({ kind: "paused", model: "claude-opus-5-5" });
    const reset = (1 * 3600 + 32 * 60 + 14) * 1000;
    if (outcome.kind !== "paused") throw new Error("not paused");
    expect(outcome.until).toBeGreaterThanOrEqual(before + reset);

    const paused = await rootOf(job.id);
    expect(paused.task?.state).toBe("blocked");
    expect(paused.task?.blocked?.kind).toBe(INFERENCE_KIND);
    expect(paused.labels).toMatchObject({
      [RESUME_LABEL]: "ses-claude-1",
      [WAIT_UNTIL_LABEL]: new Date(outcome.until).toISOString(),
      [WAIT_MODEL_LABEL]: "claude-opus-5-5",
    });
    expect(paused.labels[WAIT_SINCE_LABEL]).toBeDefined();
    expect(paused.labels).not.toHaveProperty(REPORT_LABEL); // no report: the asker hears once, from the agent
    await expect(stat(join(root, "work", "jobs", job.id, "draft.css"))).resolves.toBeDefined();
  });

  it("reads a rate limit from Claude Code's error result, and nothing else", () => {
    const result = (fields: Record<string, unknown>) =>
      JSON.stringify({ type: "result", is_error: true, ...fields });
    expect(
      harnessRateLimit(
        result({ api_error_status: 429, result: "API Error: Request rejected (429) (reset after 2m)" }),
      ),
    ).toEqual({
      resetMs: 120_000,
    });
    expect(harnessRateLimit(result({ api_error_status: 429, result: "Request rejected" }))).toEqual({});
    expect(harnessRateLimit(result({ api_error_status: 401, result: "Failed to authenticate" }))).toBeNull();
    expect(harnessRateLimit(result({ result: "usage limit reached" }))).toBeNull();
    expect(harnessRateLimit("boom: rate limited")).toBeNull(); // stderr chatter isn't the CLI's verdict
  });
});

describe("keeping work after a failure", () => {
  it("throws away a short failed run's clone, so its machine goes", async () => {
    const job = await postJob(team, spec);
    await work({ mode: "fail" });
    expect((await rootOf(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
    await expect(stat(join(root, "work", "jobs", job.id))).rejects.toThrow();
    expect(KEEP_AFTER_MS).toBe(10 * 60_000);
  });

  it("tells a resumed session what happened since it stopped, and only that", () => {
    const replies = [
      { text: "Started by claude: claude opus/high on acme/web." },
      { text: "**Question:** Which colors?" },
      { text: "Answer from Slack:\n\nRed." },
      { text: "Started by claude: claude opus/high on acme/web." },
      { text: "**Question:** Which shade of red?" },
      { text: "Answer from Slack:\n\nCrimson." },
      { text: "Started by claude: claude opus/high on acme/web." },
    ];
    expect(sinceLastRun(replies).map((reply) => reply.text)).toEqual([
      "**Question:** Which shade of red?",
      "Answer from Slack:\n\nCrimson.",
    ]);
    const prompt = resumePrompt(sinceLastRun(replies));
    expect(prompt).toContain("Crimson.");
    expect(prompt).not.toContain("Which colors?");
    expect(prompt).toContain("`QUESTION: `");
  });
});
