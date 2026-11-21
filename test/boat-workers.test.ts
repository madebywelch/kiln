import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { POOL, readEnvFile, renderEnvFile, renderUnit, workerEnv } from "../scripts/boat-workers.ts";

const shared = {
  BOARD_TOKEN: "vc_board",
  VERCEL_ORG_ID: "team_x",
  KILN_BOARD_FROM: "vercel:project:prj_x:production",
  GH_TOKEN: "ghp_x",
};
const claude1 = POOL.find((worker) => worker.profile === "claude-1")!;
const opencode1 = POOL.find((worker) => worker.profile === "opencode-1")!;

describe("workerEnv", () => {
  it("names the shared settings that are missing", () => {
    expect(() => workerEnv(claude1, { CLAUDE_TOKEN_1: "t" }, {}, "abc")).toThrow(
      /BOARD_TOKEN, VERCEL_ORG_ID, KILN_BOARD_FROM, GH_TOKEN/,
    );
  });

  it("gives each worker only its own model credential", () => {
    const env = {
      ...shared,
      CLAUDE_TOKEN_1: "claude-one",
      CLAUDE_TOKEN_2: "claude-two",
      AI_GATEWAY_API_KEY: "gw",
    };
    const claude = workerEnv(claude1, env, {}, "abc");
    expect(claude).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "claude-one",
      BOARD_PROFILE: "claude-1",
      WORKER_HARNESS: "claude",
      WORK_DIR: "/home/user/work",
      KILN_VERSION: "abc",
    });
    expect(Object.values(claude)).not.toContain("claude-two");
    expect(claude.AI_GATEWAY_API_KEY).toBeUndefined();

    const opencode = workerEnv(opencode1, env, { LINEAR_API_KEY: "lin" }, "abc");
    expect(opencode).toMatchObject({
      AI_GATEWAY_API_KEY: "gw",
      WORKER_HARNESS: "opencode",
      LINEAR_API_KEY: "lin",
    });
    expect(opencode.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe("POOL", () => {
  it("gives every worker a machine big enough for a dev build", () => {
    expect(POOL.every((worker) => worker.type !== "small")).toBe(true);
  });
});

describe("rendering", () => {
  it("quotes environment values for systemd and refuses newlines", () => {
    expect(renderEnvFile({ A: 'say "hi"', B: "back\\slash" })).toBe('A="say \\"hi\\""\nB="back\\\\slash"\n');
    expect(() => renderEnvFile({ A: "two\nlines" })).toThrow(/one line/);
  });

  it("runs the worker as the machine's user with its node, restarting it always", () => {
    const unit = renderUnit("/home/user/.nvm/versions/node/v24/bin/node", "/usr/bin:/bin");
    expect(unit).toContain("ExecStart=/home/user/.nvm/versions/node/v24/bin/node worker/main.ts");
    expect(unit).toContain("EnvironmentFile=/home/user/.kiln/worker.env");
    expect(unit).toContain("Environment=PATH=/usr/bin:/bin");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("User=user");
  });

  it("reads a dotenv file without running it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiln-env-"));
    await writeFile(join(dir, ".env"), '# comment\nA=1\nB="two words"\nEMPTY=\n  C = three \n');
    expect(readEnvFile(join(dir, ".env"))).toEqual({ A: "1", B: "two words", C: "three" });
    expect(readEnvFile(join(dir, "missing"))).toEqual({});
    await rm(dir, { recursive: true });
  });
});
