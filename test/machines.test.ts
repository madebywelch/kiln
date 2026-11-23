import { type Board, board, type ClaimedTask } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { beforeEach, describe, expect, it } from "vitest";
import { postJob, prioritizeJob } from "../lib/board-jobs.ts";
import { Boat } from "../lib/boat.ts";
import { machineLimits } from "../lib/config.ts";
import type { ProbeResult } from "../lib/inference.ts";
import {
  INFERENCE_KIND,
  type JobSpec,
  KEPT_UNTIL_LABEL,
  NOTICE_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
  RESUME_LABEL,
  RESUMED_AT_LABEL,
  WAIT_MODEL_LABEL,
  WAIT_SINCE_LABEL,
  WAIT_UNTIL_LABEL,
} from "../lib/jobs.ts";
import {
  discardKeptMachine,
  FAILED_STARTS_LABEL,
  harnessIssue,
  INFERENCE_RECHECK_MS,
  type InferenceNotices,
  LAUNCHES_LABEL,
  type LaunchConfig,
  launchConfig,
  launchMachine,
  MAX_FAILED_STARTS,
  MAX_INFERENCE_WAIT_MS,
  type MachineDeps,
  reconcileMachines,
  STARTUP_GRACE_MS,
  setupScript,
  WORKER_SETTINGS_PATH,
  workerCode,
  workerSettings,
} from "../lib/machines.ts";
import { FakeBoat } from "./fixtures/fake-boat.ts";

const env = {
  KILN_WORKER_CODE: "https://codeload.github.com/acme/kiln/tar.gz/abc123",
  WORKER_BOARD_TOKEN: "board",
  WORKER_VERCEL_ORG_ID: "team_x",
  WORKER_GH_TOKEN: "ghp_push",
  INFERENCE_BASE_URL: "https://llm.example.com",
  INFERENCE_API_KEY: "sk-endpoint",
  WORKER_AI_GATEWAY_API_KEY: "gateway",
  UNRELATED: "not for workers",
  KILN_CONFIG: JSON.stringify({
    repos: { web: { github: "acme/web", description: "the games site" } },
  }),
};
const config = launchConfig(env) as LaunchConfig;
// Most tests here cover the per-token harness too, so they run with every harness on.
const everyHarness: LaunchConfig = { ...config, enabled: ["claude", "codex", "opencode"] };

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

let team: Board;
let fake: FakeBoat;
let deps: MachineDeps;
let now: number;
const events: { event: string; fields?: Record<string, unknown> }[] = [];

beforeEach(() => {
  team = board({ backend: local({ memory: true }) });
  fake = new FakeBoat();
  now = Date.now();
  fake.now = () => new Date(now).toISOString();
  events.length = 0;
  deps = {
    team,
    boat: new Boat("key", fake.fetch),
    config: everyHarness,
    log: (event, fields) => events.push({ event, ...(fields ? { fields } : {}) }),
    now: () => now,
  };
});

const message = async (id: string) => (await team.thread(id, { limit: 1 })).message;

describe("launchConfig", () => {
  it("names what the agent's project is missing", () => {
    expect(launchConfig({})).toBe(
      "set KILN_WORKER_CODE (deploy with pnpm run deploy), WORKER_BOARD_TOKEN, WORKER_VERCEL_ORG_ID, WORKER_GH_TOKEN on the agent's Vercel project",
    );
  });

  it("passes WORKER_ settings to workers under their own names, and nothing else", () => {
    expect(config.settings).toEqual({
      BOARD_TOKEN: "board",
      VERCEL_ORG_ID: "team_x",
      GH_TOKEN: "ghp_push",
      AI_GATEWAY_API_KEY: "gateway",
    });
    expect(config.inference).toEqual({ baseURL: "https://llm.example.com", apiKey: "sk-endpoint" });
    expect(config.jobTimeoutMinutes).toBe(180);
  });
});

describe("workerCode", () => {
  it("runs the commit this deployment was built from when Vercel names it, else the one deploy pinned", () => {
    const git = {
      VERCEL_GIT_PROVIDER: "github",
      VERCEL_GIT_REPO_OWNER: "acme",
      VERCEL_GIT_REPO_SLUG: "kiln",
      VERCEL_GIT_COMMIT_SHA: "73f3805",
    };
    expect(workerCode({ ...git, KILN_WORKER_CODE: "https://old" })).toBe(
      "https://codeload.github.com/acme/kiln/tar.gz/73f3805",
    );
    expect(workerCode({ ...git, VERCEL_GIT_PROVIDER: "gitlab", KILN_WORKER_CODE: "https://pinned" })).toBe(
      "https://pinned",
    );
    expect(workerCode({})).toBeUndefined();
    expect((launchConfig({ ...env, KILN_WORKER_CODE: "", ...git }) as LaunchConfig).code).toContain(
      "73f3805",
    );
  });
});

describe("workerSettings", () => {
  it("gives each machine its own harness's credential and not another's", () => {
    const claude = workerSettings("msg_1", "claude", config);
    expect(claude).toMatchObject({
      INFERENCE_BASE_URL: "https://llm.example.com",
      INFERENCE_API_KEY: "sk-endpoint",
      KILN_JOB_ID: "msg_1",
      WORKER_HARNESS: "claude",
      BOARD_PROFILE: "claude",
    });
    expect(claude.AI_GATEWAY_API_KEY).toBeUndefined();
    const opencode = workerSettings("msg_1", "opencode", config);
    expect(opencode.AI_GATEWAY_API_KEY).toBe("gateway");
    expect(opencode.INFERENCE_API_KEY).toBeUndefined();
  });

  it("names the job's secrets for the worker to hide, never their values", () => {
    expect(
      workerSettings("msg_1", "claude", config, undefined, ["DATABASE_URL", "STRIPE_API_KEY"]),
    ).toMatchObject({
      KILN_SECRET_NAMES: "DATABASE_URL,STRIPE_API_KEY",
    });
    expect(workerSettings("msg_1", "claude", config).KILN_SECRET_NAMES).toBeUndefined();
  });

  it("gives a job's machine its own repo and that repo's MCP servers, and no other repo's", () => {
    const withMcp = launchConfig({
      ...env,
      KILN_CONFIG: JSON.stringify({
        repos: {
          web: {
            github: "acme/web",
            description: "games",
            baseBranch: "dev",
            mcp: ["linear"],
          },
          docs: { github: "acme/docs", description: "docs", mcp: ["other"] },
        },
        mcpServers: { linear: { url: "https://mcp.linear.app/mcp" }, other: { command: "x" } },
      }),
    }) as LaunchConfig;
    const settings = workerSettings("msg_1", "opencode", withMcp, "web");
    expect(JSON.parse(settings.KILN_REPO ?? "{}")).toEqual({
      key: "web",
      repos: [{ key: "web", github: "acme/web", baseBranch: "dev" }],
    });
    expect(settings.KILN_AGENT_NAME).toBe("eve");
    expect(JSON.parse(settings.KILN_MCP_SERVERS ?? "{}")).toEqual({
      linear: { url: "https://mcp.linear.app/mcp" },
    });
  });

  it("refuses to launch with a KILN_CONFIG it can't read", () => {
    expect(launchConfig({ ...env, KILN_CONFIG: "{nope" })).toMatch(/KILN_CONFIG is not JSON/);
  });

  it("fails a job whose repo was taken out of kiln.config.yaml", async () => {
    const job = await postJob(team, spec);
    const gone = launchConfig({ ...env, KILN_CONFIG: "" }) as LaunchConfig;
    const { failed } = await launchMachine({ ...deps, config: gone }, job.message);
    expect(failed).toMatch(/web is no longer a repo or project in kiln.config.yaml/);
  });

  it("gives a project's job every repo in it, the project's servers, and the configured agent name", () => {
    const project = launchConfig({
      ...env,
      KILN_CONFIG: JSON.stringify({
        name: "Mabel",
        repos: {
          app: { github: "acme/app", description: "the app" },
          cloud: { github: "acme/cloud", description: "the hosted service", baseBranch: "dev" },
        },
        projects: { shop: { description: "Shop", repos: ["app", "cloud"], mcp: ["linear"] } },
        mcpServers: { linear: { url: "https://mcp.linear.app/mcp" } },
      }),
    }) as LaunchConfig;
    const settings = workerSettings("msg_1", "claude", project, "shop");
    expect(JSON.parse(settings.KILN_REPO ?? "{}")).toEqual({
      key: "shop",
      repos: [
        { key: "app", github: "acme/app" },
        { key: "cloud", github: "acme/cloud", baseBranch: "dev" },
      ],
    });
    expect(Object.keys(JSON.parse(settings.KILN_MCP_SERVERS ?? "{}"))).toEqual(["linear"]);
    expect(settings.KILN_AGENT_NAME).toBe("Mabel");
  });

  it("refuses half an inference endpoint rather than run Claude jobs without one", () => {
    expect(launchConfig({ ...env, INFERENCE_API_KEY: "" })).toMatch(
      /INFERENCE_BASE_URL is set without INFERENCE_API_KEY/,
    );
  });

  it("says why a harness can't run", () => {
    expect(harnessIssue("opencode", config)).toMatch(/opencode is off: workers run Claude Code only/);
    expect(harnessIssue("codex", everyHarness)).toMatch(/can't run codex jobs/);
    const noGateway = {
      ...(launchConfig({ ...env, WORKER_AI_GATEWAY_API_KEY: "" }) as LaunchConfig),
      enabled: everyHarness.enabled,
    };
    expect(harnessIssue("opencode", noGateway)).toMatch(/WORKER_AI_GATEWAY_API_KEY/);
    expect(harnessIssue("claude", config)).toBeNull();
    const noEndpoint = launchConfig({
      ...env,
      INFERENCE_BASE_URL: "",
      INFERENCE_API_KEY: "",
    }) as LaunchConfig;
    expect(harnessIssue("claude", noEndpoint)).toMatch(/INFERENCE_BASE_URL and INFERENCE_API_KEY/);
  });
});

describe("setupScript", () => {
  it("downloads the pinned commit, locks down the settings file, and starts the worker in the background", () => {
    const script = setupScript("https://codeload.github.com/acme/kiln/tar.gz/abc'123");
    expect(script).toContain("curl -fsSL 'https://codeload.github.com/acme/kiln/tar.gz/abc'\\''123'");
    expect(script).toContain(`chmod 600 ~/${WORKER_SETTINGS_PATH}`);
    expect(script.trim().endsWith("nohup node worker/main.ts < /dev/null &")).toBe(true);
  });
});

describe("launchMachine", () => {
  it("starts a machine in the repo's secrets-only environment, with the job's settings in a file", async () => {
    const job = await postJob(team, spec);
    const { machine } = await launchMachine(deps, job.message);
    expect(machine?.id).toBe("bx_2");

    const [launched] = fake.machines;
    expect(launched?.environment).toBe("kiln-web");
    expect(launched?.labels).toEqual({ kiln: "worker", job: job.id, harness: "claude" });
    expect(launched?.snapshots).toBe(true);
    expect(launched?.ttlSeconds).toBe((180 + 30) * 60);
    const settings = JSON.parse(launched?.files[0]?.content ?? "{}");
    expect(settings).toMatchObject({
      KILN_JOB_ID: job.id,
      GH_TOKEN: "ghp_push",
      INFERENCE_API_KEY: "sk-endpoint",
    });
    expect(settings.UNRELATED).toBeUndefined();

    const [environment] = fake.environments;
    expect(environment).toMatchObject({
      passGithub: false,
      passSecrets: true,
      passSandboxCredentials: false,
      passAgentsCredentials: false,
    });
    expect((await message(job.id)).labels).toMatchObject({ [LAUNCHES_LABEL]: "1" });
  });

  it("gives two launches of the same job one machine", async () => {
    const job = await postJob(team, spec);
    await Promise.all([launchMachine(deps, job.message), launchMachine(deps, job.message)]);
    expect(fake.machines).toHaveLength(1);
  });

  it("fails a job whose harness can't run, so the thread hears why", async () => {
    const job = await postJob(team, { ...spec, harness: "codex", model: undefined });
    const { failed } = await launchMachine(deps, job.message);
    expect(failed).toMatch(/codex/);
    const settled = await message(job.id);
    expect(settled.task?.state).toBe("failed");
    expect(settled.labels[REPORT_LABEL]).toBe(REPORT_PENDING);
    expect(fake.machines).toHaveLength(0);
  });

  it("gives up after the machine failed to start too often", async () => {
    const job = await postJob(team, spec);
    await team.label(job.id, { set: { [FAILED_STARTS_LABEL]: String(MAX_FAILED_STARTS) } });
    const { failed } = await launchMachine(deps, await message(job.id));
    expect(failed).toMatch(/failed to start 3 times/);
    expect((await message(job.id)).task?.state).toBe("failed");
  });

  it("launches nothing and fails nothing while the agent's project lacks settings", async () => {
    const job = await postJob(team, spec);
    const result = await launchMachine({ ...deps, config: "set KILN_WORKER_CODE" }, job.message);
    expect(result).toEqual({});
    expect((await message(job.id)).task?.state).toBe("ready");
    expect(events.map((e) => e.event)).toEqual(["machines.unconfigured"]);
  });
});

describe("reconcileMachines", () => {
  it("starts a priority job before older queued jobs, and a job moved up later the same way", async () => {
    const limit = machineLimits.claude ?? 0;
    const queued = [];
    for (let i = 0; i < limit + 2; i++) queued.push(await postJob(team, { ...spec, title: `Snow ${i}` }));
    const urgent = await postJob(team, { ...spec, title: "Fix the email going out at 1pm", priority: true });
    const first = await reconcileMachines(deps);
    expect(first.launched).toContain(urgent.id);
    expect(first.launched).toHaveLength(limit);
    expect(first.waiting).toEqual(queued.slice(limit - 1).map((job) => job.id));

    // The newest of the waiting jobs is moved up: it takes the next free slot, not the oldest waiting job.
    const moved = queued.at(-1);
    await prioritizeJob(team, moved?.id ?? "");
    const done = fake.machines.find((machine) => machine.labels.job === urgent.id);
    if (done) fake.machines.splice(fake.machines.indexOf(done), 1);
    const claim = await team.tasks.claim(urgent.id, { lease: 60 });
    await claim.complete("done");
    const second = await reconcileMachines(deps);
    expect(second.launched).toEqual([moved?.id]);
  });

  it("moves up only a queued job", async () => {
    const job = await postJob(team, spec);
    const claim = await team.tasks.claim(job.id, { lease: 60 });
    await claim.fail("boom");
    await expect(prioritizeJob(team, job.id)).rejects.toThrow(/only a queued job can move up/);
  });

  it("launches a machine for each ready job, up to each harness's limit", async () => {
    const limit = machineLimits.claude ?? 0;
    const claude = [];
    for (let i = 0; i <= limit; i++) claude.push(await postJob(team, { ...spec, title: `Snow ${i}` }));
    const research = await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    const over = claude.pop();
    const result = await reconcileMachines(deps);
    expect(result.launched.sort()).toEqual([...claude, research].map((job) => job.id).sort());
    expect(result.waiting).toEqual([over?.id]); // claude runs machineLimits.claude at a time
    expect(fake.machines).toHaveLength(limit + 1);

    // Nothing changes on the next pass while those run.
    const again = await reconcileMachines(deps);
    expect(again.launched).toEqual([]);
    expect(fake.machines).toHaveLength(limit + 1);
  });

  it("launches nothing for a job someone other than the agent posted", async () => {
    await postJob(team.as("intruder"), spec);
    const result = await reconcileMachines(deps);
    expect(result).toEqual({
      launched: [],
      resumed: [],
      stopped: [],
      deleted: [],
      failed: [],
      waiting: [],
      inferenceHeld: false,
    });
    expect(fake.machines).toHaveLength(0);
  });

  it("deletes the machine once its job is over, and starts the next job", async () => {
    const first = await postJob(team, spec);
    for (let i = 1; i < (machineLimits.claude ?? 0); i++)
      await postJob(team, { ...spec, title: `Snow ${i}` });
    const next = await postJob(team, { ...spec, title: "Most snow" });
    await reconcileMachines(deps);
    const machine = fake.machines.find((m) => m.labels.job === first.id)?.id;
    const claim = await team.as("claude").tasks.claim(first.id, { lease: 60 });
    await claim.complete("done");

    const result = await reconcileMachines(deps);
    expect(result.deleted).toEqual([{ machine, job: first.id, why: "its job is over" }]);
    expect(result.launched).toEqual([next.id]);
    expect(fake.machines.map((m) => m.labels.job)).not.toContain(first.id);
  });

  it("deletes the machine of a job waiting for an answer, and of a canceled job", async () => {
    const asked = await postJob(team, spec);
    const canceled = await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    await reconcileMachines(deps);
    const claim = await team.as("claude").tasks.claim(asked.id, { lease: 60 });
    await claim.block("which shade of white?", { kind: "needs_input" });
    await team.tasks.cancel(canceled.id, "never mind");

    const result = await reconcileMachines(deps);
    expect(result.deleted.map((d) => d.why).sort()).toEqual([
      "its job is over",
      "its job is waiting for an answer",
    ]);
    expect(fake.machines).toHaveLength(0);
  });

  it("replaces a machine whose worker never claimed the job, counting the failed start", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    now += STARTUP_GRACE_MS + 1;
    const result = await reconcileMachines(deps);
    expect(result.deleted).toEqual([
      { machine: "bx_2", job: job.id, why: "its worker never claimed the job" },
    ]);
    expect(result.launched).toEqual([job.id]);
    expect(fake.machines.map((m) => m.id)).toEqual(["bx_3"]);
    expect((await message(job.id)).labels).toMatchObject({
      [LAUNCHES_LABEL]: "2",
      [FAILED_STARTS_LABEL]: "1",
    });
  });

  it("replaces a machine whose setup failed", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    const [machine] = fake.machines;
    if (machine) Object.assign(machine, { setupStatus: "failed", setupError: "curl: (22) 404" });
    const result = await reconcileMachines(deps);
    expect(result.deleted[0]?.why).toBe("setup failed: curl: (22) 404");
    expect(result.launched).toEqual([job.id]);
  });

  it("leaves a running job's machine alone", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await team.as("claude").tasks.claim(job.id, { lease: 300 });
    now += STARTUP_GRACE_MS * 3;
    const result = await reconcileMachines(deps);
    expect(result.deleted).toEqual([]);
    expect(fake.machines).toHaveLength(1);
  });
});

const iso = (ms: number) => new Date(ms).toISOString();
const asker = {
  authenticator: "slack-webhook",
  principalType: "user",
  principalId: "slack:T1:U1",
  issuer: "slack:T1",
  userId: "U1",
} as const;

/** Runs a job on its machine until the worker settles it the way `settle` says, as a worker does. */
async function runUntil(
  jobId: string,
  settle: (claim: ClaimedTask) => Promise<unknown>,
  labels: Record<string, string> = {},
) {
  const claim = await team.as("claude").tasks.claim(jobId, { lease: 300 });
  if (Object.keys(labels).length) await team.label(jobId, { set: labels });
  await settle(claim);
}

describe("keeping a job's work on its stopped machine", () => {
  it("stops the machine of a job paused with its work, and resumes it, worker and all, once answered", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    const machine = fake.machines[0];
    await runUntil(job.id, (claim) => claim.block("which shade of white?", { kind: "needs_input" }), {
      [RESUME_LABEL]: "ses-1",
    });

    const paused = await reconcileMachines(deps);
    expect(paused.stopped).toEqual([
      { machine: machine?.id, job: job.id, why: "its job is paused; its work is kept" },
    ]);
    expect(paused.deleted).toEqual([]);
    expect(machine?.state).toBe("archived");
    // While it waits, nothing touches it.
    expect(await reconcileMachines(deps)).toMatchObject({
      stopped: [],
      deleted: [],
      resumed: [],
      launched: [],
    });

    now += 60 * 60_000;
    await team.tasks.unblock(job.id);
    const resumed = await reconcileMachines(deps);
    expect(resumed.resumed).toEqual([job.id]);
    expect(resumed.launched).toEqual([]);
    expect(machine).toMatchObject({ state: "provisioning", resumes: 1, ttlSeconds: (180 + 30) * 60 });
    expect(fake.upgrades).toEqual([{ environment: expect.any(String), machine: machine?.id }]);
    expect((await message(job.id)).labels[RESUMED_AT_LABEL]).toBe(iso(now));

    // Up: the agent writes the worker's settings and starts it, once per resume.
    if (machine) machine.state = "ready";
    await reconcileMachines(deps);
    await reconcileMachines(deps);
    const settings = machine?.files.filter((file) => file.path === WORKER_SETTINGS_PATH) ?? [];
    expect(settings).toHaveLength(2); // one at launch, one at resume
    expect(JSON.parse(settings[1]?.content ?? "{}")).toMatchObject({
      KILN_JOB_ID: job.id,
      GH_TOKEN: "ghp_push",
    });
    const started = machine?.commands.filter((command) => command.detached) ?? [];
    expect(started).toHaveLength(1);
    expect(started[0]?.command).toContain("nohup node worker/main.ts");
    expect(machine?.commands.some((command) => command.command.includes("ghp_push"))).toBe(false);
  });

  it("gives a resumed machine its own startup grace, then replaces it with a fresh one", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await runUntil(job.id, (claim) => claim.block("which shade?", { kind: "needs_input" }), {
      [RESUME_LABEL]: "ses-1",
    });
    await reconcileMachines(deps);
    now += STARTUP_GRACE_MS * 5;
    await team.tasks.unblock(job.id);
    await reconcileMachines(deps);
    expect((await reconcileMachines(deps)).deleted).toEqual([]);
    now += STARTUP_GRACE_MS + 1;
    const result = await reconcileMachines(deps);
    expect(result.deleted[0]?.why).toBe("its worker never claimed the job");
    expect((await message(job.id)).labels[RESUME_LABEL]).toBeUndefined();
  });

  it("deletes a paused job's machine when nothing ran on it, as before", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await runUntil(job.id, (claim) => claim.block("Set LINEAR_API_KEY for web.", { kind: "needs_secret" }));
    expect((await reconcileMachines(deps)).deleted[0]?.why).toBe("its job is waiting for an answer");
  });

  it("keeps a failed job's work for the kept days, then deletes it", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await runUntil(job.id, (claim) => claim.fail("claude timed out after 180m"), { [RESUME_LABEL]: "ses-1" });
    const failed = await reconcileMachines(deps);
    expect(failed.stopped[0]?.why).toBe("its job failed; its work is kept for retry_job");
    const until = now + 3 * 24 * 60 * 60_000;
    expect((await message(job.id)).labels[KEPT_UNTIL_LABEL]).toBe(iso(until));

    now = until + 1;
    const expired = await reconcileMachines(deps);
    expect(expired.deleted[0]?.why).toBe("its job's kept work expired");
    expect(fake.machines).toHaveLength(0);
    expect((await message(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
  });

  it("starts a job over on a fresh machine when its saved disk is gone", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await runUntil(job.id, (claim) => claim.fail("boom"), { [RESUME_LABEL]: "ses-1" });
    await reconcileMachines(deps);
    const kept = fake.machines[0];
    if (kept) fake.expired.add(kept.id);
    await team.tasks.reopen(job.id);
    const gone = await reconcileMachines(deps);
    expect(gone.waiting).toEqual([job.id]);
    expect(fake.machines).toHaveLength(0);
    expect((await message(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
    expect((await reconcileMachines(deps)).launched).toEqual([job.id]);
  });

  it("discards kept work on request, so a retry starts over", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    await runUntil(job.id, (claim) => claim.fail("boom"), { [RESUME_LABEL]: "ses-1" });
    await reconcileMachines(deps);
    expect(await discardKeptMachine(deps, job.id)).toBe(true);
    expect(fake.machines).toHaveLength(0);
    expect((await message(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
  });
});

describe("an account with snapshots off", () => {
  it("still runs jobs, on machines without snapshots, and deletes rather than stops them", async () => {
    fake.snapshotsOff = true;
    const job = await postJob(team, spec);
    expect((await reconcileMachines(deps)).launched).toEqual([job.id]);
    expect(fake.machines[0]).toMatchObject({ snapshots: false, labels: { snapshots: "off" } });
    expect(events.map((e) => e.event)).toContain("machines.snapshots_off");

    await runUntil(job.id, (claim) => claim.block("which shade?", { kind: "needs_input" }), {
      [RESUME_LABEL]: "ses-1",
    });
    const result = await reconcileMachines(deps);
    expect(result.stopped).toEqual([]);
    expect(result.deleted[0]?.why).toBe("its job is waiting for an answer");
    expect((await message(job.id)).labels).not.toHaveProperty(RESUME_LABEL);
  });
});

describe("waiting for inference", () => {
  let probes: string[];
  let answers: ProbeResult[];
  let said: { kind: string; to?: string; notice?: string; at?: number; jobs?: readonly string[] }[];

  beforeEach(() => {
    probes = [];
    answers = [];
    said = [];
    const notices: InferenceNotices = {
      paused: async (who, until) => {
        said.push({ kind: "paused", to: who.userId, at: until });
        return `D1:${said.length}`;
      },
      back: async (notice, since) => void said.push({ kind: "back", notice, at: since }),
      gaveUp: async (notice, jobs) => void said.push({ kind: "gaveUp", notice, jobs }),
    };
    deps = {
      ...deps,
      notices,
      probeModel: "claude-fable-5-2",
      probe: async (model) => {
        probes.push(model);
        return answers.shift() ?? { ok: true };
      },
    };
  });

  const asked: JobSpec = { ...spec, origin: { channelId: "C1", threadTs: "1.2", asker } };

  /** Launches jobs, then runs each until the endpoint refuses it, as the worker settles one. */
  async function rateLimited(titles: string[], resetMs: number) {
    const jobs = [];
    for (const title of titles) jobs.push(await postJob(team, { ...asked, title }));
    await reconcileMachines(deps);
    for (const [index, job] of jobs.entries()) await pause(job.id, `ses-${titles[index]}`, resetMs);
    return jobs;
  }

  async function pause(id: string, session: string, resetMs: number) {
    await runUntil(id, (claim) => claim.block("Waiting for inference", { kind: INFERENCE_KIND }), {
      [RESUME_LABEL]: session,
      [WAIT_UNTIL_LABEL]: iso(now + resetMs),
      [WAIT_SINCE_LABEL]: iso(now),
      [WAIT_MODEL_LABEL]: "claude-opus-5-5",
    });
  }

  it("holds every Claude job until the endpoint answers, tells the asker once, then continues paused work first", async () => {
    const [first, second] = await rateLimited(["first", "second"], 60 * 60_000);
    if (!first || !second) throw new Error("no jobs");
    const queued = await postJob(team, { ...asked, title: "queued" });

    const held = await reconcileMachines(deps);
    expect(held.inferenceHeld).toBe(true);
    expect(held.waiting).toEqual([queued.id]);
    expect(held.stopped.map((s) => s.job).sort()).toEqual([first.id, second.id].sort());
    expect(probes).toEqual([]); // nothing is due yet
    expect(said).toEqual([{ kind: "paused", to: "U1", at: now + 60 * 60_000 }]);
    expect((await message(first.id)).labels[NOTICE_LABEL]).toBe("D1:1");
    expect((await message(second.id)).labels[NOTICE_LABEL]).toBe("D1:1");

    // Due, and still limited: check again when the endpoint says, telling no one again.
    now += 60 * 60_000;
    answers.push({ ok: false, limit: { resetMs: 30 * 60_000 }, why: "429" });
    expect((await reconcileMachines(deps)).inferenceHeld).toBe(true);
    expect(probes).toEqual(["claude-opus-5-5"]);
    expect((await message(first.id)).labels[WAIT_UNTIL_LABEL]).toBe(iso(now + 30 * 60_000));
    expect(said).toHaveLength(1);

    now += 30 * 60_000;
    const back = await reconcileMachines(deps);
    expect(back.inferenceHeld).toBe(false);
    expect(back.resumed.sort()).toEqual([first.id, second.id].sort());
    expect(back.launched).toEqual([queued.id]);
    expect(said.at(-1)).toEqual({ kind: "back", notice: "D1:1", at: now - 90 * 60_000 });
    const labels = (await message(first.id)).labels;
    expect((await message(first.id)).task?.state).toBe("ready");
    for (const label of [WAIT_UNTIL_LABEL, WAIT_SINCE_LABEL, WAIT_MODEL_LABEL, NOTICE_LABEL]) {
      expect(labels).not.toHaveProperty(label);
    }
    expect(labels[RESUME_LABEL]).toBe("ses-first");
  });

  it("checks again in a while when the endpoint doesn't say when it resets", async () => {
    await rateLimited(["first"], 0);
    answers.push({ ok: false, limit: null, why: "503" });
    await reconcileMachines(deps);
    const [job] = (await team.tasks.list({ channel: "jobs", state: "open" })).tasks;
    expect(job?.message.labels[WAIT_UNTIL_LABEL]).toBe(iso(now + INFERENCE_RECHECK_MS));
  });

  it("gives up after a day, failing the job with its work kept, and says so in the same message", async () => {
    const [job] = await rateLimited(["first"], 60 * 60_000);
    if (!job) throw new Error("no job");
    await reconcileMachines(deps);
    now += MAX_INFERENCE_WAIT_MS + 1;
    answers.push({ ok: false, limit: null, why: "429" });
    const result = await reconcileMachines(deps);
    expect(result.inferenceHeld).toBe(false);
    const root = await message(job.id);
    expect(root.task?.state).toBe("failed");
    expect(root.task?.reason).toContain("inference stayed rate limited for a day");
    expect(root.labels).toMatchObject({ [REPORT_LABEL]: REPORT_PENDING, [RESUME_LABEL]: "ses-first" });
    expect(root.labels[KEPT_UNTIL_LABEL]).toBeDefined();
    expect(said.at(-1)).toEqual({
      kind: "gaveUp",
      notice: "D1:1",
      jobs: [`#${job.id.replace(/^msg_/, "").slice(0, 8)}`],
    });
  });

  it("leaves jobs on other harnesses alone", async () => {
    await rateLimited(["first"], 60 * 60_000);
    const gateway = await postJob(team, { ...asked, harness: "opencode", model: "openai/gpt-6-luna-fast" });
    expect((await reconcileMachines(deps)).launched).toEqual([gateway.id]);
  });
});
