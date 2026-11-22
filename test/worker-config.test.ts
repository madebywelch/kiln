import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSettingsFile, parseConfig } from "../worker/main.ts";

const base = {
  BOARD_PROFILE: "claude-1",
  WORKER_HARNESS: "claude",
  GH_TOKEN: "ghp_x",
  KILN_JOB_ID: "msg_1",
  CLAUDE_CODE_OAUTH_TOKEN: "t",
};

describe("parseConfig", () => {
  it("names every missing setting", () => {
    const parsed = parseConfig({});
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual([
      "BOARD_PROFILE",
      "WORKER_HARNESS",
      "GH_TOKEN",
      "KILN_JOB_ID",
    ]);
  });

  it("treats empty values as unset", () => {
    const parsed = parseConfig({
      ...base,
      JOB_TIMEOUT_MINUTES: "",
      KILN_GIT_NAME: "",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ JOB_TIMEOUT_MINUTES: 180, WORK_DIR: "/work" });
    expect(parsed.data?.KILN_GIT_NAME).toBeUndefined();
  });

  it("refuses a profile the board would refuse", () => {
    expect(parseConfig({ ...base, BOARD_PROFILE: "claude_1" }).success).toBe(false);
    expect(parseConfig({ ...base, BOARD_PROFILE: `c${"x".repeat(32)}` }).success).toBe(false);
  });

  it("refuses a claude worker without its subscription token", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...noToken } = base;
    const parsed = parseConfig({ ...noToken, CLAUDE_CODE_OAUTH_TOKEN: "" });
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(parseConfig({ ...noToken, BOARD_PROFILE: "codex-1", WORKER_HARNESS: "codex" }).success).toBe(true);
  });

  it("starts a claude worker on the inference endpoint with no subscription token, and only with both halves", () => {
    const { CLAUDE_CODE_OAUTH_TOKEN: _token, ...noToken } = base;
    const endpoint = { INFERENCE_BASE_URL: "https://llm.example.com", INFERENCE_API_KEY: "sk-endpoint" };
    expect(parseConfig({ ...noToken, ...endpoint }).success).toBe(true);
    expect(parseConfig({ ...noToken, INFERENCE_BASE_URL: endpoint.INFERENCE_BASE_URL }).success).toBe(false);
  });

  it("refuses a harness the worker cannot run", () => {
    expect(parseConfig({ ...base, WORKER_HARNESS: "antigravity" }).success).toBe(false);
  });
});

describe("loadSettingsFile", () => {
  it("moves the agent's settings into the environment, over what a repo secret set, and deletes the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiln-settings-"));
    const path = join(dir, "worker.json");
    await writeFile(path, JSON.stringify({ GH_TOKEN: "worker", KILN_JOB_ID: "msg_1" }));
    const env: NodeJS.ProcessEnv = { GH_TOKEN: "from-a-repo-secret", LINEAR_API_KEY: "lin" };
    expect(loadSettingsFile(path, env)).toBe(true);
    expect(env).toEqual({ GH_TOKEN: "worker", KILN_JOB_ID: "msg_1", LINEAR_API_KEY: "lin" });
    expect(existsSync(path)).toBe(false);
    expect(loadSettingsFile(path, env)).toBe(false);
    await rm(dir, { recursive: true });
  });
});
