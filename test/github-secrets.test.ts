import sodium from "libsodium-wrappers";
import { beforeEach, describe, expect, it } from "vitest";
import { Boat, variableValue } from "../lib/boat.ts";
import { memoryDrive } from "../lib/drive.ts";
import {
  type CopyDeps,
  copyIssue,
  copySecretsToGitHub,
  githubName,
  githubNameIssue,
  putGitHubSecret,
  updateGitHubCopies,
} from "../lib/github-secrets.ts";
import { readSecretLabels } from "../lib/secret-labels.ts";
import { setSecret } from "../lib/secrets.ts";
import { FakeBoat } from "./fixtures/fake-boat.ts";

/** GitHub's secrets API: hands out a real public key and opens what it is sent, as GitHub would. */
class FakeGitHub {
  readonly secrets = new Map<string, string>();
  readonly environments = new Set(["acme/web/production"]);
  readonly requests: { method: string; path: string; authorization: string | null }[] = [];
  status: number | null = null;
  #keys: sodium.KeyPair | undefined;

  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    await sodium.ready;
    this.#keys ??= sodium.crypto_box_keypair();
    const keys = this.#keys;
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const authorization = new Headers(init?.headers).get("authorization");
    this.requests.push({ method, path: url.pathname, authorization });
    if (this.status)
      return Response.json({ message: "Resource not accessible by integration" }, { status: this.status });
    const match =
      /^\/repos\/([^/]+\/[^/]+)\/(?:environments\/([^/]+)\/secrets|actions\/secrets)\/([^/]+)$/.exec(
        url.pathname,
      );
    if (!match) return Response.json({ message: "Not Found" }, { status: 404 });
    const [, repo, environment, name] = match;
    if (environment && !this.environments.has(`${repo}/${decodeURIComponent(environment)}`))
      return Response.json({ message: "Not Found" }, { status: 404 });
    if (method === "GET" && name === "public-key")
      return Response.json({
        key_id: "key-1",
        key: sodium.to_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
      });
    if (method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { encrypted_value: string; key_id: string };
      if (body.key_id !== "key-1") return Response.json({ message: "bad key" }, { status: 422 });
      const sealed = sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL);
      const value = sodium.to_string(sodium.crypto_box_seal_open(sealed, keys.publicKey, keys.privateKey));
      this.secrets.set(`${repo}${environment ? `/${environment}` : ""}:${name}`, value);
      return new Response(null, { status: 201 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
}

let github: FakeGitHub;
let fake: FakeBoat;
let deps: CopyDeps;

beforeEach(() => {
  github = new FakeGitHub();
  fake = new FakeBoat();
  deps = {
    boat: new Boat("key", fake.fetch),
    labels: memoryDrive(),
    token: "ghp_agent",
    githubRepos: (key) => (key === "web" ? ["acme/web", "acme/api"] : []),
    fetch: github.fetch,
  };
});

describe("putGitHubSecret", () => {
  it("seals the value with the repo's key, so GitHub opens exactly what was saved", async () => {
    await putGitHubSecret(
      "ghp_agent",
      { repo: "acme/web", name: "FLY_API_TOKEN" },
      "fly v1 tok,en",
      github.fetch,
    );
    await putGitHubSecret(
      "ghp_agent",
      { repo: "acme/web", environment: "production", name: "FLY_API_TOKEN" },
      "prod-token",
      github.fetch,
    );
    expect(github.secrets.get("acme/web:FLY_API_TOKEN")).toBe("fly v1 tok,en");
    expect(github.secrets.get("acme/web/production:FLY_API_TOKEN")).toBe("prod-token");
    expect(github.requests.every((r) => r.authorization === "Bearer ghp_agent")).toBe(true);
    expect(github.requests.map((r) => `${r.method} ${r.path}`)).toContain(
      "PUT /repos/acme/web/environments/production/secrets/FLY_API_TOKEN",
    );
  });

  it("says to create a missing environment instead of creating one without protection rules", async () => {
    await expect(
      putGitHubSecret("t", { repo: "acme/web", environment: "staging", name: "KEY" }, "v", github.fetch),
    ).rejects.toThrow(
      "acme/web has no staging environment, or the agent's GitHub token can't see it. Create it first",
    );
    expect(github.requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("names the permissions the token lacks", async () => {
    github.status = 403;
    await expect(
      putGitHubSecret("t", { repo: "acme/web", environment: "production", name: "KEY" }, "v", github.fetch),
    ).rejects.toThrow(/needs Secrets read and write, and Environments read and write, on acme\/web/);
  });
});

describe("GitHub names", () => {
  it("drops the group's prefix, which a GitHub environment says instead", () => {
    expect(githubName("PROD_WRITE_FLY_API_TOKEN", "production-write")).toBe("FLY_API_TOKEN");
    expect(githubName("PROD_READ_DATABASE_URL", "production-read")).toBe("DATABASE_URL");
    expect(githubName("RETELL_API_KEY", "staging")).toBe("RETELL_API_KEY");
  });

  it("refuses names GitHub won't take", () => {
    expect(githubNameIssue("FLY_API_TOKEN")).toBeNull();
    expect(githubNameIssue("GITHUB_TOKEN")).toMatch(/reserves/);
    expect(githubNameIssue("1KEY")).toMatch(/capitals/);
  });
});

describe("copyIssue", () => {
  const request = {
    repo: "web",
    group: "production-write" as const,
    github: "acme/web",
    environment: "production",
    secrets: [{ name: "PROD_WRITE_FLY_API_TOKEN", as: "FLY_API_TOKEN" }],
  };

  it("allows a project's own repo, and production only into an environment", () => {
    expect(copyIssue(deps, request)).toBeNull();
    expect(copyIssue(deps, { ...request, github: "ACME/API" })).toBeNull();
    expect(copyIssue(deps, { ...request, environment: undefined })).toMatch(/only into a GitHub environment/);
    expect(copyIssue(deps, { ...request, group: "staging", environment: undefined })).toBeNull();
  });

  it("refuses another repo, a reserved name, and a missing token", () => {
    expect(copyIssue(deps, { ...request, github: "evil/repo" })).toBe(
      "evil/repo isn't one of web's repos (acme/web, acme/api)",
    );
    expect(copyIssue(deps, { ...request, secrets: [{ name: "X_KEY", as: "GITHUB_X" }] })).toMatch(/reserves/);
    expect(copyIssue({ ...deps, token: undefined }, request)).toMatch(/no GitHub token/);
  });
});

describe("copySecretsToGitHub and updateGitHubCopies", () => {
  const copy = {
    repo: "web",
    group: "production-write" as const,
    github: "acme/web",
    environment: "production",
    secrets: [{ name: "PROD_WRITE_FLY_API_TOKEN", as: "FLY_API_TOKEN" }],
  };

  it("copies a value from boat, quoted or not, records the copy once, and never says the value", async () => {
    const value = "FlyV1 fm2_lJPE?a=1&b=2";
    await setSecret(deps.boat, "web", "production-write", "PROD_WRITE_FLY_API_TOKEN", value);
    const said = await copySecretsToGitHub(deps, copy);
    await copySecretsToGitHub(deps, copy);
    expect(said).toBe(
      "copied `PROD_WRITE_FLY_API_TOKEN` as `FLY_API_TOKEN` from *web*'s *production-write* secrets to acme/web's production environment.",
    );
    expect(github.secrets.get("acme/web/production:FLY_API_TOKEN")).toBe(value);
    const label = (await readSecretLabels(deps.labels))["kiln-web-production-write"]
      ?.PROD_WRITE_FLY_API_TOKEN;
    expect(label?.github).toEqual([{ repo: "acme/web", environment: "production", name: "FLY_API_TOKEN" }]);
  });

  it("copies what it can and names what it couldn't, with the reason", async () => {
    await setSecret(deps.boat, "web", "production-write", "PROD_WRITE_FLY_API_TOKEN", "fly-token-value");
    const said = await copySecretsToGitHub(deps, {
      ...copy,
      secrets: [...copy.secrets, { name: "PROD_WRITE_MISSING", as: "MISSING" }],
    });
    expect(said).toContain("copied `PROD_WRITE_FLY_API_TOKEN` as `FLY_API_TOKEN`");
    expect(said).toContain(
      "Not copied: `PROD_WRITE_MISSING`: PROD_WRITE_MISSING isn't in web's production-write secrets.",
    );
    expect(said).not.toContain("fly-token-value");
  });

  it("copies nothing when the target isn't allowed", async () => {
    expect(await copySecretsToGitHub(deps, { ...copy, github: "evil/repo" })).toMatch(
      /^couldn't copy secrets/,
    );
    expect(github.requests).toEqual([]);
  });

  it("puts a value saved again into every copy, and says nothing for a secret with none", async () => {
    await setSecret(deps.boat, "web", "production-write", "PROD_WRITE_FLY_API_TOKEN", "old-token-value");
    await copySecretsToGitHub(deps, copy);
    const said = await updateGitHubCopies(
      deps,
      "kiln-web-production-write",
      "PROD_WRITE_FLY_API_TOKEN",
      "new-token",
    );
    expect(said).toBe("Updated in GitHub: acme/web's production environment as FLY_API_TOKEN.");
    expect(github.secrets.get("acme/web/production:FLY_API_TOKEN")).toBe("new-token");
    expect(await updateGitHubCopies(deps, "kiln-web-staging", "OTHER", "x")).toBeUndefined();
    github.status = 403;
    expect(
      await updateGitHubCopies(deps, "kiln-web-production-write", "PROD_WRITE_FLY_API_TOKEN", "newer"),
    ).toMatch(
      /^Not updated in GitHub: acme\/web's production environment as FLY_API_TOKEN: the agent's GitHub token/,
    );
  });
});

describe("variableValue", () => {
  it("reads a value as boat writes it, bare or quoted, and refuses escapes it can't read back exactly", () => {
    const env = 'A=plain\nB="has spaces?&"\nC=\'single\'\nD="esc\\"aped"\nA=last';
    expect(variableValue(env, "A")).toBe("last");
    expect(variableValue(env, "B")).toBe("has spaces?&");
    expect(variableValue(env, "C")).toBe("single");
    expect(variableValue(env, "MISSING")).toBeUndefined();
    expect(() => variableValue(env, "D")).toThrow(/escapes/);
  });
});
