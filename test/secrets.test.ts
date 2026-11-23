import { beforeEach, describe, expect, it } from "vitest";
import { Boat, variableNames } from "../lib/boat.ts";
import { memoryDrive } from "../lib/drive.ts";
import { daysUntil, expiryIssue, labelSecret, readSecretLabels } from "../lib/secret-labels.ts";
import {
  deleteSecret,
  environmentName,
  jobEnvironment,
  jobEnvironmentName,
  NO_SECRETS_ENVIRONMENT,
  secretNameIssue,
  secretNames,
  secretNamesByGroup,
  setSecret,
} from "../lib/secrets.ts";
import { FakeBoat } from "./fixtures/fake-boat.ts";

let fake: FakeBoat;
let boat: Boat;

beforeEach(() => {
  fake = new FakeBoat();
  boat = new Boat("key", fake.fetch);
});

describe("secretNameIssue", () => {
  it("accepts an ordinary variable name", () => {
    expect(secretNameIssue("LINEAR_API_KEY", "staging")).toBeNull();
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
      expect(secretNameIssue(name, "staging"), name).toMatch(/reserved/);
    }
  });

  it("refuses names that aren't capitals, digits, and underscores", () => {
    for (const name of ["linear_key", "1KEY", "A-B", "", "A B"])
      expect(secretNameIssue(name, "staging"), name).toMatch(/capital/);
  });

  it("names production secrets with their group's prefix and staging ones plainly", () => {
    expect(secretNameIssue("DATABASE_URL", "staging")).toBeNull();
    expect(secretNameIssue("PROD_READ_DATABASE_URL", "production-read")).toBeNull();
    expect(secretNameIssue("PROD_WRITE_DEPLOY_TOKEN", "production-write")).toBeNull();
    expect(secretNameIssue("PROD_READ_GRAFANA_READ_TOKEN", "production-read")).toBeNull();
    expect(secretNameIssue("DATABASE_URL", "production-read")).toBe(
      "a production-read secret's name is PROD_READ_ and then what it is, so PROD_READ_DATABASE_URL",
    );
    expect(secretNameIssue("PROD_READ_DATABASE_URL", "production-write")).toContain(
      "so PROD_WRITE_DATABASE_URL",
    );
    expect(secretNameIssue("PROD_WRITE_DEPLOY_TOKEN", "staging")).toContain("so DEPLOY_TOKEN");
  });

  it("refuses every other way of saying where a secret reaches", () => {
    const renamed: [string, Parameters<typeof secretNameIssue>[1], string][] = [
      ["STAGING_FLY_API_TOKEN", "staging", "FLY_API_TOKEN"],
      ["DATABASE_URL_PROD", "production-read", "PROD_READ_DATABASE_URL"],
      ["PROD_READONLY_DATABASE_URL", "production-read", "PROD_READ_DATABASE_URL"],
      ["PROD_READ_STRIPE_READONLY_API_KEY", "production-read", "PROD_READ_STRIPE_API_KEY"],
    ];
    for (const [name, group, plain] of renamed)
      expect(secretNameIssue(name, group), name).toContain(`so ${plain}`);
    for (const name of ["PRODUCT_ID", "STAGED_ROLLOUT_KEY", "GRAFANA_READ_TOKEN", "DEVICE_KEY"])
      expect(secretNameIssue(name, "staging"), name).toBeNull();
    expect(secretNameIssue("PROD_READ_", "production-read")).toBe(
      "a production-read secret's name is PROD_READ_ and then what it is",
    );
  });
});

describe("jobEnvironment", () => {
  it("creates a group's environment passing secrets and nothing else", async () => {
    const environment = await jobEnvironment(boat, "web", "production-read");
    expect(environment.name).toBe(environmentName("web", "production-read"));
    expect(fake.environments[0]).toMatchObject({
      name: "kiln-web-production-read",
      safeForThirdParties: false,
      passGithub: false,
      passSecrets: true,
      passSandboxCredentials: false,
      passAgentsCredentials: false,
    });
  });

  it("gives every job with no secrets the one empty environment", async () => {
    expect((await jobEnvironment(boat, "web", "none")).name).toBe(NO_SECRETS_ENVIRONMENT);
    expect((await jobEnvironment(boat, "api", "none")).name).toBe(NO_SECRETS_ENVIRONMENT);
    expect(fake.environments).toHaveLength(1);
    expect(jobEnvironmentName("web", "staging")).toBe("kiln-web-staging");
  });

  it("puts the flags back when someone switched GitHub on in the dashboard", async () => {
    await jobEnvironment(boat, "web", "staging");
    const [environment] = fake.environments;
    if (environment) environment.passGithub = true;
    const events: string[] = [];
    await jobEnvironment(boat, "web", "staging", (event) => events.push(event));
    expect(fake.environments[0]?.passGithub).toBe(false);
    expect(events).toEqual(["secrets.environment_flags_reset"]);
  });
});

describe("setSecret, secretNames, and deleteSecret", () => {
  it("stores a value in its group only and lists only names", async () => {
    await setSecret(boat, "web", "staging", "LINEAR_API_KEY", "lin_secret_value");
    expect(fake.environments[0]?.vars).toEqual({ LINEAR_API_KEY: "lin_secret_value" });
    const names = await secretNames(boat, "web", "staging");
    expect(names).toEqual(["LINEAR_API_KEY"]);
    expect(JSON.stringify(names)).not.toContain("lin_secret_value");
    expect(await secretNames(boat, "web", "production-read")).toEqual([]);
    expect(await secretNames(boat, "web", "none")).toEqual([]);
    expect(await secretNamesByGroup(boat, "web")).toEqual({
      staging: ["LINEAR_API_KEY"],
      "production-read": [],
      "production-write": [],
    });
  });

  it("deletes a secret from its group, and says when there was none", async () => {
    await setSecret(boat, "web", "staging", "HELLO_WORLD", "a-test-value");
    expect(await deleteSecret(boat, "web", "production-read", "HELLO_WORLD")).toBe(false);
    expect(await deleteSecret(boat, "web", "staging", "HELLO_WORLD")).toBe(true);
    expect(await secretNames(boat, "web", "staging")).toEqual([]);
  });

  it("lists nothing for a group with no environment yet, without creating one", async () => {
    expect(await secretNames(boat, "web", "staging")).toEqual([]);
    expect(fake.environments).toHaveLength(0);
  });

  it("refuses empty, multi-line, reserved, and where-named secrets before calling boat", async () => {
    await expect(setSecret(boat, "web", "staging", "LINEAR_API_KEY", "")).rejects.toThrow(/empty/);
    await expect(setSecret(boat, "web", "staging", "LINEAR_API_KEY", "a\nb")).rejects.toThrow(/one line/);
    await expect(setSecret(boat, "web", "staging", "GH_TOKEN", "x")).rejects.toThrow(/reserved/);
    await expect(setSecret(boat, "web", "staging", "STAGING_KEY", "x")).rejects.toThrow(/so KEY/);
    expect(fake.requests).toEqual([]);
  });
});

describe("secret labels", () => {
  it("records what a secret is beside it, and forgets it on delete", async () => {
    const store = memoryDrive();
    const label = {
      description: "Linear",
      savedBy: "U1",
      savedAt: "2026-11-23T00:00:00Z",
      expires: "2026-12-01",
    };
    await labelSecret(store, "kiln-web-staging", "LINEAR_API_KEY", label);
    await labelSecret(store, "kiln-web-staging", "OTHER_KEY", { ...label, description: "other" });
    expect((await readSecretLabels(store))["kiln-web-staging"]?.LINEAR_API_KEY).toEqual(label);
    await labelSecret(store, "kiln-web-staging", "LINEAR_API_KEY", null);
    expect(Object.keys((await readSecretLabels(store))["kiln-web-staging"] ?? {})).toEqual(["OTHER_KEY"]);
  });

  it("writes again over a label written meanwhile, instead of losing it", async () => {
    const store = memoryDrive();
    await labelSecret(store, "kiln-web-staging", "ZERO", { description: "z", savedBy: "U", savedAt: "t" });
    const racing = { ...store, read: store.read };
    let raced = false;
    racing.read = async (path) => {
      const file = await store.read(path);
      if (!raced) {
        raced = true;
        await labelSecret(store, "kiln-web-staging", "FIRST", {
          description: "a",
          savedBy: "U",
          savedAt: "t",
        });
      }
      return file;
    };
    await labelSecret(racing, "kiln-web-staging", "SECOND", { description: "b", savedBy: "U", savedAt: "t" });
    expect(Object.keys((await readSecretLabels(store))["kiln-web-staging"] ?? {}).sort()).toEqual([
      "FIRST",
      "SECOND",
      "ZERO",
    ]);
  });

  it("counts days to an expiry and checks its form", () => {
    const now = Date.parse("2026-11-23T12:00:00Z");
    expect(daysUntil("2026-11-26", now)).toBe(2);
    expect(daysUntil("2026-11-20", now)).toBeLessThan(0);
    expect(expiryIssue("2026-11-26")).toBeNull();
    expect(expiryIssue("next week")).toMatch(/YYYY-MM-DD/);
  });
});

describe("variableNames", () => {
  it("reads names from .env text and never values", () => {
    expect(variableNames("B=2\n# C=3\nexport A=one=two\n\nB=again")).toEqual(["A", "B"]);
  });
});
