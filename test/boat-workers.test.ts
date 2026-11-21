import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readEnvFile } from "../scripts/boat-workers.ts";
import { githubRepo, workerCodeUrl } from "../scripts/deploy.ts";

describe("readEnvFile", () => {
  it("reads a dotenv file without running it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kiln-env-"));
    await writeFile(join(dir, ".env"), '# comment\nA=1\nB="two words"\nEMPTY=\n  C = three \n');
    expect(readEnvFile(join(dir, ".env"))).toEqual({ A: "1", B: "two words", C: "three" });
    expect(readEnvFile(join(dir, "missing"))).toEqual({});
    await rm(dir, { recursive: true });
  });
});

describe("deploy", () => {
  it("finds the GitHub repo in https and ssh remotes", () => {
    expect(githubRepo("https://github.com/acme/kiln.git")).toBe("acme/kiln");
    expect(githubRepo("git@github.com:acme/kiln.git\n")).toBe("acme/kiln");
    expect(githubRepo("https://github.com/acme/kiln")).toBe("acme/kiln");
    expect(githubRepo("https://gitea.example/acme/kiln.git")).toBeNull();
  });

  it("pins machines to a commit's tarball", () => {
    expect(workerCodeUrl("acme/kiln", "abc123")).toBe("https://codeload.github.com/acme/kiln/tar.gz/abc123");
  });
});
