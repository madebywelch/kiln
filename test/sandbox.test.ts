import { describe, expect, it } from "vitest";
import { GH_TOKEN_PLACEHOLDER, githubPolicy } from "../agent/sandbox/sandbox.ts";

type Rule = { transform: { headers: Record<string, string> }[] };

describe("the sandbox's GitHub policy", () => {
  it("signs GitHub's API and git hosts at the firewall, leaves other egress open, and keeps the token out of the placeholder", () => {
    const policy = githubPolicy("ghp_example");
    if (typeof policy === "string") throw new Error("expected per-domain rules");
    const allow = policy.allow as Readonly<Record<string, readonly Rule[]>>;
    expect(allow["api.github.com"]).toEqual([
      { transform: [{ headers: { authorization: "Bearer ghp_example" } }] },
    ]);
    const header = allow["github.com"]?.[0]?.transform[0]?.headers.authorization ?? "";
    expect(Buffer.from(header.replace(/^Basic /, ""), "base64").toString()).toBe(
      "x-access-token:ghp_example",
    );
    expect(allow["*"]).toEqual([]);
    expect(GH_TOKEN_PLACEHOLDER).not.toMatch(/gh[pousr]_/);
  });
});
