import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, board, type ClaimedTask } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { answerJob, postJob, readJob } from "../lib/board-jobs.ts";
import type { McpServer, RepoConfig } from "../lib/config.ts";
import { JOBS_CHANNEL, type JobSpec, jobBranch, REPORT_LABEL } from "../lib/jobs.ts";
import { type Exec, exec } from "../worker/exec.ts";
import { claudeReport, harnessInvocation, opencodeReport, resolveMcp, topEffort } from "../worker/harness.ts";
import {
  buildPrompt,
  CLAIM_LOST,
  collectArtifacts,
  firstLine,
  harnessEnv,
  type OpenPullRequest,
  type Outcome,
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
  root = await mkdtemp(join(tmpdir(), "robdog-worker-"));
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
    label: { robdog: "job" },
    from: ["board:client"],
    lease: 300,
  });
  if (!claimed) throw new Error("nothing to claim");
  return claimed;
}

interface RunOptions {
  mode: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  registry?: Record<string, RepoConfig>;
  harnessEnv?: NodeJS.ProcessEnv;
  guidance?: string;
  mcpServers?: Record<string, McpServer>;
}

interface Record_ {
  args: string[];
  stdin: string;
  head?: string;
  env: { GH_TOKEN: string | null; BOARD_TOKEN: string | null; OPENCODE_CONFIG_CONTENT?: string | null };
}

async function work(options: RunOptions): Promise<{ outcome: Outcome; record: Record_ }> {
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
    cloneUrl: () => remote,
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
  });
  let record: Record_ = { args: [], stdin: "", env: { GH_TOKEN: null, BOARD_TOKEN: null } };
  try {
    record = JSON.parse(await readFile(recordFile, "utf8"));
  } catch {
    // the harness never ran
  }
  return { outcome, record };
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
      reason: expect.stringContaining("not in this worker's registry"),
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
      expect.arrayContaining(["-p", "--output-format", "json", "--model", "opus", "--effort", "high"]),
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
    expect(files.some((file) => file.startsWith(".robdog"))).toBe(false);
    const { replies } = await team.thread(job.id, { limit: 10 });
    const report = replies.at(-1);
    expect(report?.attachments.map((attachment) => attachment.name)).toEqual(["home.png"]);
    const bytes = new Uint8Array(await (await team.download(report!.attachments[0]!.id)).arrayBuffer());
    expect([...bytes]).toEqual([0x89, 0x50, 0x4e, 0x47]);
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

  it("gives a job its repo's MCP servers, with secrets from the worker's environment", async () => {
    process.env.TEST_LINEAR_KEY = "lin_secret";
    const servers: Record<string, McpServer> = {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TEST_LINEAR_KEY}" } },
      unused: { command: "never" },
    };
    const withMcp = { web: { ...registry.web!, mcp: ["linear"] } };
    await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    const { record } = await work({ mode: "nothing", registry: withMcp, mcpServers: servers });
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

  it("fails a job whose MCP servers need a secret the worker lacks", async () => {
    const servers: Record<string, McpServer> = {
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${TEST_MISSING_KEY}" } },
    };
    await postJob(team, spec);
    const { outcome } = await work({
      mode: "change",
      registry: { web: { ...registry.web!, mcp: ["linear"] } },
      mcpServers: servers,
    });
    expect(outcome).toMatchObject({ kind: "failed", reason: expect.stringContaining("TEST_MISSING_KEY") });
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
    const where = { id: "1", github: "acme/web", branch: "robdog/1", resumed: false };
    expect(buildPrompt(spec, where, [])).toContain("The worker pushes and opens a draft pull request");
    expect(buildPrompt({ ...spec, kind: "investigate" }, where, [])).toContain("Investigate and report.");
    expect(buildPrompt(spec, where, [])).toContain("QUESTION: ");
  });
});
