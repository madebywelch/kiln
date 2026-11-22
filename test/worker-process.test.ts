// The worker as it runs in production: `node worker/main.ts` against a board
// over HTTP (`vb serve`), with real git. Only the coding CLI and gh are fakes,
// found first on PATH; github.com is rewritten to a local bare repo.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Board, board } from "@vercel/board";
import { afterAll, beforeAll, expect, it } from "vitest";
import { postJob, sweepReports } from "../lib/board-jobs.ts";
import { type JobSpec, jobBranch, REPORT_LABEL } from "../lib/jobs.ts";

const repoRoot = join(import.meta.dirname, "..");
const fixtures = join(import.meta.dirname, "fixtures");

let root: string;
let remote: string;
let boardUrl: string;
let server: ChildProcess;
let team: Board;

const git = (args: string[], cwd?: string) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 4100));
    });
  });
}

async function until<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check().catch(() => undefined);
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kiln-process-"));
  remote = join(root, "remote.git");
  git(["init", "--quiet", "--bare", "-b", "main", remote]);
  const seed = join(root, "seed");
  git(["clone", "--quiet", remote, seed]);
  await writeFile(join(seed, "README.md"), "# the website\n");
  git(["add", "-A"], seed);
  git(["commit", "--quiet", "-m", "init"], seed);
  git(["push", "--quiet", "origin", "HEAD:main"], seed);

  const bin = join(root, "bin");
  await mkdir(bin);
  await chmod(join(fixtures, "fake-harness.mjs"), 0o755);
  await chmod(join(fixtures, "gh"), 0o755);
  await symlink(join(fixtures, "fake-harness.mjs"), join(bin, "claude"));
  await symlink(join(fixtures, "gh"), join(bin, "gh"));

  const port = await freePort();
  boardUrl = `http://127.0.0.1:${port}/api/board`;
  server = spawn(
    join(repoRoot, "node_modules", ".bin", "vb"),
    ["serve", "--port", String(port), "--dir", join(root, ".board"), "--no-inspect", "--no-open"],
    { cwd: root, stdio: "ignore" },
  );
  process.env.BOARD_URL = boardUrl;
  // A new client each try: one that asked before vb serve wrote its token file keeps
  // the credential it fell back to, which on CI (no Vercel login) is none.
  team = await until("the board to answer", async () => {
    const fresh = board();
    return (await fresh.me()).actor ? fresh : undefined;
  });
}, 60_000);

afterAll(async () => {
  server?.kill("SIGTERM");
  delete process.env.BOARD_URL;
  await rm(root, { recursive: true, force: true });
});

function startWorker(
  jobId: string,
  mode: string,
  record?: string,
  endpoint: Record<string, string> = {
    INFERENCE_BASE_URL: "https://llm.example.com",
    INFERENCE_API_KEY: "sk-endpoint",
  },
): { child: ChildProcess; logs: () => string } {
  let output = "";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${join(root, "bin")}:${process.env.PATH}`,
    BOARD_URL: boardUrl,
    BOARD_PROFILE: "claude",
    WORKER_HARNESS: "claude",
    KILN_JOB_ID: jobId,
    KILN_REPO: JSON.stringify({ key: "web", repos: [{ key: "web", github: "acme/web" }] }),
    GH_TOKEN: "test",
    ...endpoint,
    WORK_DIR: join(root, "work"),
    FAKE_MODE: mode,
    ...(record ? { FAKE_RECORD: record } : {}),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/acme/web.git",
  };
  const child = spawn(process.execPath, [join(repoRoot, "worker", "main.ts")], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  return { child, logs: () => output };
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });

const spec: JobSpec = {
  repo: "web",
  kind: "change",
  title: "Add snow",
  brief: "Make it snow.",
  harness: "claude",
  model: "opus",
  effort: "high",
  origin: { channelId: "C0123", threadTs: "1700000000.000100" },
};

it("claims its job, opens a PR, settles it for the agent's report, and exits", async () => {
  const job = await postJob(team, spec);
  const record = join(root, "record.json");
  const worker = startWorker(job.id, "change", record);

  const settled = await until("the job to complete", async () => {
    const { message } = await team.thread(job.id, { limit: 1 });
    return message.task?.state === "completed" ? message : undefined;
  });
  expect(settled.task?.result).toBe("Draft PR: https://github.com/acme/web/pull/1");
  expect(settled.labels[REPORT_LABEL]).toBe("pending");
  expect(git(["--git-dir", remote, "ls-tree", "-r", "--name-only", jobBranch(job.id, spec.title)])).toContain(
    "theme.css",
  );

  const seen = JSON.parse(await readFile(record, "utf8")).env;
  expect(seen.GH_TOKEN).toBeNull(); // the worker held GH_TOKEN=test; the coding CLI must not
  // The token's owner authored the work, not the agent.
  expect(git(["--git-dir", remote, "log", "-1", "--format=%an <%ae>", jobBranch(job.id, spec.title)])).toBe(
    "octo <42+octo@users.noreply.github.com>",
  );

  const keys: string[] = [];
  await sweepReports(team, async (origin, _message, key) => {
    expect(origin).toEqual(spec.origin);
    keys.push(key);
  });
  expect(keys).toEqual([`job:${job.id}:completed:1`]);

  expect(await exited(worker.child)).toBe(0);
  expect(worker.logs()).toContain('"event":"worker.done"');
}, 60_000);

it("runs a Claude job on the inference endpoint, as the agent launches it", async () => {
  const job = await postJob(team, { ...spec, title: "Snow on the endpoint" });
  const record = join(root, "record-endpoint.json");
  const worker = startWorker(job.id, "change", record, {
    INFERENCE_BASE_URL: "https://llm.example.com/v1",
    INFERENCE_API_KEY: "sk-endpoint",
  });
  const settled = await until("the job to complete", async () => {
    const { message } = await team.thread(job.id, { limit: 1 });
    return message.task?.state === "completed" ? message : undefined;
  });
  expect(settled.task?.result).toMatch(/^Draft PR: /);
  const seen = JSON.parse(await readFile(record, "utf8")).env;
  expect(seen).toMatchObject({
    ANTHROPIC_BASE_URL: "https://llm.example.com",
    ANTHROPIC_API_KEY: "sk-endpoint",
    INFERENCE_API_KEY: null,
  });
  expect(await exited(worker.child)).toBe(0);
  expect(worker.logs()).not.toContain("config.invalid");
}, 60_000);

it("exits without touching a job another machine already holds", async () => {
  const job = await postJob(team, { ...spec, title: "Taken" });
  await team.as("other").tasks.claim(job.id, { lease: 300 });
  const worker = startWorker(job.id, "change");
  expect(await exited(worker.child)).toBe(0);
  expect(worker.logs()).toContain('"event":"job.unavailable"');
  const { message } = await team.thread(job.id, { limit: 1 });
  expect(message.task?.state).toBe("claimed");
}, 60_000);

it("hands a running job back to the queue when stopped", async () => {
  const job = await postJob(team, { ...spec, title: "Slow job" });
  const worker = startWorker(job.id, "hang");
  await until("the job to be claimed", async () => {
    const { message } = await team.thread(job.id, { limit: 1 });
    return message.task?.state === "claimed" ? true : undefined;
  });
  // Let the harness start before stopping.
  await until("the harness to start", async () => (worker.logs().includes("job.harness") ? true : undefined));

  worker.child.kill("SIGTERM");
  expect(await exited(worker.child)).toBe(0);
  const { message } = await team.thread(job.id, { limit: 1 });
  expect(message.task?.state).toBe("ready");
  expect(message.labels[REPORT_LABEL]).toBeUndefined();
}, 60_000);
