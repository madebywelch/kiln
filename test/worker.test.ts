import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, board, type ClaimedTask } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ledger, readLedger, type WorkerSubscription } from "../lib/accounts.ts";
import { answerJob, postJob, readJob } from "../lib/board-jobs.ts";
import type { McpServer, RepoConfig } from "../lib/deployment.ts";
import { JOBS_CHANNEL, type JobSpec, jobBranch, REPORT_LABEL } from "../lib/jobs.ts";
import { type Exec, exec } from "../worker/exec.ts";
import { claudeReport, harnessInvocation, opencodeReport, resolveMcp, topEffort } from "../worker/harness.ts";
import {
  buildPrompt,
  CLAIM_LOST,
  collectArtifacts,
  fetchInputs,
  firstLine,
  harnessEnv,
  type OpenPullRequest,
  type Outcome,
  type RegistryEntry,
  runJob,
  SHUTDOWN,
} from "../worker/job.ts";

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
  mode: string;
  cloneUrl?: (github: string) => string;
  signal?: AbortSignal;
  timeoutMs?: number;
  registry?: Record<string, RegistryEntry>;
  harnessEnv?: NodeJS.ProcessEnv;
  guidance?: string;
  mcpServers?: Record<string, McpServer>;
  subscriptions?: WorkerSubscription[];
}

interface Record_ {
  args: string[];
  stdin: string;
  head?: string;
  env: { GH_TOKEN: string | null; BOARD_TOKEN: string | null; OPENCODE_CONFIG_CONTENT?: string | null };
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
    workDir: join(root, "work"),
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
    registry: options.registry ?? registry,
    ...(options.harnessEnv ? { harnessEnv: options.harnessEnv } : {}),
    ...(options.guidance ? { guidance: options.guidance } : {}),
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    ...(options.subscriptions ? { subscriptions: options.subscriptions } : {}),
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

describe("change jobs", () => {
  it("commits, pushes the job's branch, opens a draft PR, and completes", async () => {
    const job = await postJob(team, spec);
    const { outcome, record } = await work({ mode: "change" });
    const branch = jobBranch(job.id, spec.title);

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
    const branch = jobBranch(job.id, spec.title);
    expect(git(["--git-dir", remote, "log", "-1", "--format=%s", branch])).toBe("Add snow");
    expect(pullRequests).toHaveLength(1);
  });

  it("completes without a PR when nothing changed", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "nothing" });
    expect(outcome).toMatchObject({ kind: "completed", result: "No changes made." });
    expect(pullRequests).toEqual([]);
    expect(() => remoteFiles(jobBranch(job.id, spec.title))).toThrow();
  });

  it("blocks on a question, keeps the work, and resumes from it with the answer", async () => {
    const job = await postJob(team, spec);
    const first = await work({ mode: "question" });
    expect(first.outcome).toMatchObject({ kind: "blocked", question: "Which colors should the theme use?" });
    const branch = jobBranch(job.id, spec.title);
    expect(remoteFiles(branch)).toContain("draft.css");
    const blocked = await rootOf(job.id);
    expect(blocked.task?.state).toBe("blocked");
    expect(blocked.task?.blocked).toEqual({
      kind: "needs_input",
      reason: "Which colors should the theme use?",
    });

    await answerJob(team, job.id, "Red and green.");
    const second = await work({ mode: "change" });
    expect(second.record.stdin).toContain("holds work from an earlier run");
    expect(second.record.stdin).toContain("Red and green.");
    expect(second.record.stdin).not.toContain("Started by");
    expect(second.outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(branch)).toEqual(expect.arrayContaining(["draft.css", "theme.css"]));
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
    const branch = jobBranch(job.id, shopSpec.title);
    expect(remoteFiles(branch)).toContain("theme.css");
    expect(git(["--git-dir", cloud, "ls-tree", "-r", "--name-only", branch]).split("\n")).toContain(
      "theme.css",
    );
    expect(pullRequests.map((pr) => pr.github).sort()).toEqual(["acme/cloud", "acme/web"]);
    expect(pullRequests[0]?.body).toContain("project shop: web, cloud");
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
    const branch = jobBranch(job.id, shopSpec.title);
    expect(pullRequests.map((pr) => pr.github)).toEqual(["acme/web"]);
    expect(() => git(["--git-dir", cloud, "rev-parse", "--verify", branch])).toThrow();
    expect(outcome.kind === "completed" && outcome.result).toBe(
      "Draft PR: https://github.com/acme/web/pull/7",
    );
  });
});

describe("credentials", () => {
  const workerEnv = { ...process.env, GH_TOKEN: "ghp_write", BOARD_TOKEN: "board_secret" };

  it("keeps the worker's push token and board login from the coding CLI, and still pushes", async () => {
    const job = await postJob(team, spec);
    const { outcome, record } = await work({ mode: "change", harnessEnv: harnessEnv(workerEnv) });
    expect(record.env).toMatchObject({ GH_TOKEN: null, BOARD_TOKEN: null });
    expect(outcome).toMatchObject({ kind: "completed" });
    expect(remoteFiles(jobBranch(job.id, spec.title))).toContain("theme.css");
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
    expect(() => remoteFiles(jobBranch(job.id, spec.title))).toThrow();
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
    const files = remoteFiles(jobBranch(job.id, spec.title));
    expect(files).toContain("theme.css");
    expect(files.some((file) => file.startsWith(".kiln"))).toBe(false);
    const { replies } = await team.thread(job.id, { limit: 10 });
    const report = replies.at(-1);
    expect(report?.attachments.map((attachment) => attachment.name)).toEqual(["home.png"]);
    const bytes = new Uint8Array(await (await team.download(report!.attachments[0]!.id)).arrayBuffer());
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
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
    const branch = jobBranch(job.id, spec.title);
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

  it("takes at most ten files, and nothing from a missing folder", async () => {
    const dir = join(root, "artifacts");
    await mkdir(dir);
    for (let index = 0; index < 12; index++)
      await writeFile(join(dir, `f${String(index).padStart(2, "0")}.txt`), "x");
    const artifacts = await collectArtifacts(dir);
    expect(artifacts.map((artifact) => artifact.name)).toEqual(
      Array.from({ length: 10 }, (_, index) => `f${String(index).padStart(2, "0")}.txt`),
    );
    expect(await collectArtifacts(join(root, "nowhere"))).toEqual([]);
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

  it("pauses a job whose CLI ends asking for a secret by name, with its work pushed", async () => {
    const job = await postJob(team, spec);
    const { outcome } = await work({ mode: "secret" });
    expect(outcome).toMatchObject({
      kind: "blocked",
      secrets: ["STRIPE_API_KEY", "DATABASE_URL"],
      question: "Set STRIPE_API_KEY, DATABASE_URL for web: read the customer's payment history",
    });
    expect((await rootOf(job.id)).labels.needs_secrets).toBe("STRIPE_API_KEY,DATABASE_URL");
    expect(remoteFiles(jobBranch(job.id, spec.title))).toContain("draft.css");
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

describe("subscriptions", () => {
  async function subscriptions(): Promise<WorkerSubscription[]> {
    const states = await ledger(team, "claude", ["a", "b"]);
    return [
      { id: "a", token: "sub-a", record: states.get("a")?.record ?? "" },
      { id: "b", token: "sub-b", record: states.get("b")?.record ?? "" },
    ];
  }

  it("moves a job to the next subscription when its own runs out, resuming the session on the same model", async () => {
    const job = await postJob(team, spec);
    const subs = await subscriptions();
    const { outcome, runs } = await work({ mode: "exhausted-first", subscriptions: subs });

    expect(outcome.kind).toBe("completed");
    expect(runs.map((run) => run.token)).toEqual(["sub-a", "sub-b"]);
    expect(runs[0]?.args).not.toContain("--resume");
    expect(runs[1]?.args).toEqual(expect.arrayContaining(["--resume", "ses-claude-1", "--model", "opus"]));
    expect(runs[0]?.args).toEqual(expect.arrayContaining(["--model", "opus"]));

    const states = await readLedger(team, "claude");
    expect(states.get("a")?.benches.all).toBe(1_900_000_000);
    expect(states.get("b")?.usage.seven_day?.percent).toBe(42);
    const { log } = await readJob(team, job.id);
    expect(log.some((entry) => /out of usage .*continuing on b, same model/.test(entry.text))).toBe(true);
    expect((await rootOf(job.id)).labels.account).toBe("b");
  }, 30_000);

  it("never hands the coding CLI the other subscriptions' tokens", async () => {
    await postJob(team, spec);
    const { record } = await work({
      mode: "change",
      subscriptions: await subscriptions(),
      harnessEnv: harnessEnv({ ...process.env, KILN_SUBSCRIPTIONS: "[secret]" }),
    });
    expect(record.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: "sub-a", KILN_SUBSCRIPTIONS: null });
  }, 30_000);

  it("hands the job back to wait for usage when every subscription is out, with its work pushed", async () => {
    const job = await postJob(team, spec);
    const { outcome, runs } = await work({ mode: "exhausted-all", subscriptions: await subscriptions() });

    expect(outcome).toMatchObject({ kind: "waiting", until: 1_900_000_000 });
    expect(runs.map((run) => run.token)).toEqual(["sub-a", "sub-b"]);
    const root = await rootOf(job.id);
    expect(root.task?.state).toBe("ready");
    expect(root.labels.waiting).toBe("1900000000");
    expect(root.labels.account).toBeUndefined();
    expect(root.labels[REPORT_LABEL]).toBeUndefined();
    expect(
      git(["--git-dir", remote, "ls-tree", "-r", "--name-only", jobBranch(job.id, spec.title)]),
    ).toContain("draft.css");
  }, 30_000);
});
