import { type Board, board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { beforeEach, describe, expect, it } from "vitest";
import { postJob } from "../lib/board-jobs.ts";
import { Boat } from "../lib/boat.ts";
import { type JobSpec, REPORT_LABEL, REPORT_PENDING } from "../lib/jobs.ts";
import {
  harnessIssue,
  LAUNCHES_LABEL,
  type LaunchConfig,
  launchConfig,
  launchMachine,
  MAX_LAUNCHES,
  type MachineDeps,
  reconcileMachines,
  STARTUP_GRACE_MS,
  setupScript,
  WORKER_SETTINGS_PATH,
  workerSettings,
} from "../lib/machines.ts";
import { FakeBoat } from "./fixtures/fake-boat.ts";

const env = {
  KILN_WORKER_CODE: "https://codeload.github.com/acme/kiln/tar.gz/abc123",
  WORKER_BOARD_TOKEN: "board",
  WORKER_VERCEL_ORG_ID: "team_x",
  WORKER_GH_TOKEN: "ghp_push",
  WORKER_CLAUDE_CODE_OAUTH_TOKEN: "claude-sub",
  WORKER_AI_GATEWAY_API_KEY: "gateway",
  UNRELATED: "not for workers",
};
const config = launchConfig(env) as LaunchConfig;

const spec: JobSpec = {
  repo: "player.games-app",
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
    config,
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
      CLAUDE_CODE_OAUTH_TOKEN: "claude-sub",
      AI_GATEWAY_API_KEY: "gateway",
    });
    expect(config.jobTimeoutMinutes).toBe(180);
  });
});

describe("workerSettings", () => {
  it("gives each machine its own harness's credential and not another's", () => {
    const claude = workerSettings("msg_1", "claude", config);
    expect(claude).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "claude-sub",
      KILN_JOB_ID: "msg_1",
      WORKER_HARNESS: "claude",
      BOARD_PROFILE: "claude",
    });
    expect(claude.AI_GATEWAY_API_KEY).toBeUndefined();
    const opencode = workerSettings("msg_1", "opencode", config);
    expect(opencode.AI_GATEWAY_API_KEY).toBe("gateway");
    expect(opencode.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("says why a harness can't run", () => {
    expect(harnessIssue("codex", config)).toMatch(/can't run codex jobs/);
    const noGateway = launchConfig({ ...env, WORKER_AI_GATEWAY_API_KEY: "" }) as LaunchConfig;
    expect(harnessIssue("opencode", noGateway)).toMatch(/WORKER_AI_GATEWAY_API_KEY/);
    expect(harnessIssue("claude", config)).toBeNull();
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
    expect(launched?.environment).toBe("kiln-player.games-app");
    expect(launched?.labels).toEqual({ kiln: "worker", job: job.id, harness: "claude" });
    expect(launched?.snapshots).toBe(false);
    expect(launched?.ttlSeconds).toBe((180 + 30) * 60);
    const settings = JSON.parse(launched?.files[0]?.content ?? "{}");
    expect(settings).toMatchObject({
      KILN_JOB_ID: job.id,
      GH_TOKEN: "ghp_push",
      CLAUDE_CODE_OAUTH_TOKEN: "claude-sub",
    });
    expect(settings.UNRELATED).toBeUndefined();

    const [environment] = fake.environments;
    expect(environment).toMatchObject({
      passGithub: false,
      passSecrets: true,
      passSandboxCredentials: false,
      passAgentsCredentials: false,
    });
    expect((await message(job.id)).labels[LAUNCHES_LABEL]).toBe("1");
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
    await team.label(job.id, { set: { [LAUNCHES_LABEL]: String(MAX_LAUNCHES) } });
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
  it("launches a machine for each ready job, within each harness's limit", async () => {
    const first = await postJob(team, spec);
    const second = await postJob(team, { ...spec, title: "More snow" });
    const research = await postJob(team, {
      ...spec,
      kind: "investigate",
      harness: "opencode",
      model: "openai/gpt-6-luna-fast",
    });
    const result = await reconcileMachines(deps);
    expect(result.launched.sort()).toEqual([first.id, research.id].sort());
    expect(result.waiting).toEqual([second.id]); // claude allows one at a time
    expect(fake.machines).toHaveLength(2);

    // Nothing changes on the next pass while those run.
    const again = await reconcileMachines(deps);
    expect(again.launched).toEqual([]);
    expect(fake.machines).toHaveLength(2);
  });

  it("launches nothing for a job someone other than the agent posted", async () => {
    await postJob(team.as("intruder"), spec);
    const result = await reconcileMachines(deps);
    expect(result).toEqual({ launched: [], deleted: [], failed: [], waiting: [] });
    expect(fake.machines).toHaveLength(0);
  });

  it("deletes the machine once its job is over, and starts the next job", async () => {
    const first = await postJob(team, spec);
    const second = await postJob(team, { ...spec, title: "More snow" });
    await reconcileMachines(deps);
    const claim = await team.as("claude").tasks.claim(first.id, { lease: 60 });
    await claim.complete("done");

    const result = await reconcileMachines(deps);
    expect(result.deleted).toEqual([{ machine: "bx_2", job: first.id, why: "its job is over" }]);
    expect(result.launched).toEqual([second.id]);
    expect(fake.machines.map((m) => m.labels.job)).toEqual([second.id]);
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

  it("replaces a machine whose worker never claimed the job, counting the launch", async () => {
    const job = await postJob(team, spec);
    await reconcileMachines(deps);
    now += STARTUP_GRACE_MS + 1;
    const result = await reconcileMachines(deps);
    expect(result.deleted).toEqual([
      { machine: "bx_2", job: job.id, why: "its worker never claimed the job" },
    ]);
    expect(result.launched).toEqual([job.id]);
    expect(fake.machines.map((m) => m.id)).toEqual(["bx_3"]);
    expect((await message(job.id)).labels[LAUNCHES_LABEL]).toBe("2");
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
