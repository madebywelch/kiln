import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../worker/exec.ts";
import { ghPullRequest, loadSettingsFile, parseConfig } from "../worker/main.ts";

const base = {
  BOARD_PROFILE: "claude-1",
  WORKER_HARNESS: "claude",
  GH_TOKEN: "ghp_x",
  KILN_JOB_ID: "msg_1",
  INFERENCE_BASE_URL: "https://llm.example.com",
  INFERENCE_API_KEY: "sk-endpoint",
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

  it("starts a claude worker only with the whole inference endpoint", () => {
    const { INFERENCE_BASE_URL: _url, INFERENCE_API_KEY: _key, ...noEndpoint } = base;
    expect(parseConfig(base).success).toBe(true);
    const parsed = parseConfig({ ...noEndpoint, INFERENCE_BASE_URL: "https://llm.example.com" });
    expect(parsed.error?.issues.map((issue) => issue.path.join("."))).toEqual(["INFERENCE_BASE_URL"]);
    expect(parseConfig({ ...noEndpoint, BOARD_PROFILE: "codex-1", WORKER_HARNESS: "codex" }).success).toBe(
      true,
    );
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

describe("ghPullRequest", () => {
  /** A fake gh over a repo's pull requests, answering the way gh does. */
  function fakeGh(prs: { url: string; head: string; state: "OPEN" | "CLOSED" | "MERGED" }[]) {
    const created: string[][] = [];
    const exec: Exec = async (_command, args) => {
      const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false, aborted: false });
      const arg = (flag: string) => args[args.indexOf(flag) + 1];
      if (args[1] === "view") {
        // `gh pr view <branch>` finds the branch's latest pull request, in any state.
        const pr = prs.findLast((candidate) => candidate.head === args[2]);
        return pr ? ok(`${pr.url}\n`) : { ...ok(""), code: 1 };
      }
      if (args[1] === "list") {
        const state = arg("--state")?.toUpperCase();
        const pr = prs.find(
          (candidate) => candidate.head === arg("--head") && (!state || candidate.state === state),
        );
        return ok(pr ? `${pr.url}\n` : "");
      }
      if (args[1] === "create") {
        created.push([...args]);
        return ok("https://github.com/acme/web/pull/9\n");
      }
      throw new Error(`unexpected gh ${args.join(" ")}`);
    };
    return { exec, created };
  }
  const request = {
    cwd: "/w",
    github: "acme/web",
    base: "main",
    head: "octo/fix-it",
    title: "Fix it",
    body: "b",
  };

  it("opens a new draft PR when the branch's only PR is closed, instead of reporting the closed one", async () => {
    const gh = fakeGh([{ url: "https://github.com/acme/web/pull/1", head: "octo/fix-it", state: "CLOSED" }]);
    expect(await ghPullRequest(gh.exec)(request)).toBe("https://github.com/acme/web/pull/9");
    expect(gh.created).toHaveLength(1);
  });

  it("reuses the branch's open PR, as a resumed job's", async () => {
    const gh = fakeGh([
      { url: "https://github.com/acme/web/pull/1", head: "octo/fix-it", state: "MERGED" },
      { url: "https://github.com/acme/web/pull/4", head: "octo/fix-it", state: "OPEN" },
    ]);
    expect(await ghPullRequest(gh.exec)(request)).toBe("https://github.com/acme/web/pull/4");
    expect(gh.created).toHaveLength(0);
  });
});
