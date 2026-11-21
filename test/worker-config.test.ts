import { describe, expect, it } from "vitest";
import { parseConfig } from "../worker/main.ts";

const base = {
  BOARD_PROFILE: "claude-1",
  WORKER_HARNESS: "claude",
  GH_TOKEN: "ghp_x",
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
    ]);
  });

  it("treats the empty strings compose passes for unset values as unset", () => {
    const parsed = parseConfig({
      ...base,
      JOB_TIMEOUT_MINUTES: "",
      KILN_GIT_NAME: "",
      KILN_BOARD_FROM: "",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({ JOB_TIMEOUT_MINUTES: 180, KILN_BOARD_FROM: "", WORK_DIR: "/work" });
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

  it("refuses a harness the worker cannot run", () => {
    expect(parseConfig({ ...base, WORKER_HARNESS: "antigravity" }).success).toBe(false);
  });
});
