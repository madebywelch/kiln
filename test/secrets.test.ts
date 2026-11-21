import { beforeEach, describe, expect, it } from "vitest";
import { Boat, variableNames } from "../lib/boat.ts";
import { environmentName, repoEnvironment, secretNameIssue, secretNames, setSecret } from "../lib/secrets.ts";
import { FakeBoat } from "./fixtures/fake-boat.ts";

let fake: FakeBoat;
let boat: Boat;

beforeEach(() => {
  fake = new FakeBoat();
  boat = new Boat("key", fake.fetch);
});

describe("secretNameIssue", () => {
  it("accepts an ordinary variable name", () => {
    expect(secretNameIssue("LINEAR_API_KEY")).toBeNull();
  });

  it("refuses names that would shadow the worker's credentials or change how programs run", () => {
    for (const name of [
      "GH_TOKEN",
      "BOARD_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "PATH",
      "NODE_OPTIONS",
      "KILN_JOB_ID",
      "GIT_DIR",
      "BOAT_ID",
    ]) {
      expect(secretNameIssue(name), name).toMatch(/reserved/);
    }
  });

  it("refuses names that aren't capitals, digits, and underscores", () => {
    for (const name of ["linear_key", "1KEY", "A-B", "", "A B"])
      expect(secretNameIssue(name), name).toMatch(/capital/);
  });
});

describe("repoEnvironment", () => {
  it("creates the repo's environment passing secrets and nothing else", async () => {
    const environment = await repoEnvironment(boat, "web");
    expect(environment.name).toBe(environmentName("web"));
    expect(fake.environments[0]).toMatchObject({
      name: "kiln-web",
      safeForThirdParties: false,
      passGithub: false,
      passSecrets: true,
      passSandboxCredentials: false,
      passAgentsCredentials: false,
    });
  });

  it("puts the flags back when someone switched GitHub on in the dashboard", async () => {
    await repoEnvironment(boat, "web");
    const [environment] = fake.environments;
    if (environment) environment.passGithub = true;
    const events: string[] = [];
    await repoEnvironment(boat, "web", (event) => events.push(event));
    expect(fake.environments[0]?.passGithub).toBe(false);
    expect(events).toEqual(["secrets.environment_flags_reset"]);
  });
});

describe("setSecret and secretNames", () => {
  it("stores a value and lists only names", async () => {
    await setSecret(boat, "web", "LINEAR_API_KEY", "lin_secret_value");
    expect(fake.environments[0]?.vars).toEqual({ LINEAR_API_KEY: "lin_secret_value" });
    const names = await secretNames(boat, "web");
    expect(names).toEqual(["LINEAR_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain("lin_secret_value");
  });

  it("lists nothing for a repo with no environment yet, without creating one", async () => {
    expect(await secretNames(boat, "web")).toEqual([]);
    expect(fake.environments).toHaveLength(0);
  });

  it("refuses empty, multi-line, and reserved secrets before calling boat", async () => {
    await expect(setSecret(boat, "web", "LINEAR_API_KEY", "")).rejects.toThrow(/empty/);
    await expect(setSecret(boat, "web", "LINEAR_API_KEY", "a\nb")).rejects.toThrow(/one line/);
    await expect(setSecret(boat, "web", "GH_TOKEN", "x")).rejects.toThrow(/reserved/);
    expect(fake.requests).toEqual([]);
  });
});

describe("variableNames", () => {
  it("reads names from .env text and never values", () => {
    expect(variableNames("B=2\n# C=3\nexport A=one=two\n\nB=again")).toEqual(["A", "B"]);
  });
});
