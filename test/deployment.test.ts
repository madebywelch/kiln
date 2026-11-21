import { describe, expect, it } from "vitest";
import { parseDeployment, secretsNamedBy, serversFor } from "../lib/deployment.ts";
import { configSetting } from "../scripts/deploy.ts";

const yaml = `
repos:
  player.games-app:
    github: acme/player-games
    description: Player Games, the website and its creator hub.
    defaults:
      investigate: { harness: opencode, model: openai/gpt-6-luna-fast }
    mcp: [linear, admin]
  docs:
    github: acme/docs
    description: The docs site.
mcpServers:
  linear:
    url: https://mcp.linear.app/mcp
    headers:
      Authorization: Bearer \${LINEAR_API_KEY}
  admin:
    url: \${ADMIN_MCP_URL}
  postgres:
    command: npx
    args: ["-y", "server-postgres", "\${DATABASE_URL}"]
`;

describe("kiln.config.yaml", () => {
  it("becomes KILN_CONFIG: the repos, and each repo's servers and nothing else", () => {
    const config = parseDeployment(configSetting(yaml));
    if (typeof config === "string") throw new Error(config);
    expect(Object.keys(config.repos)).toEqual(["player.games-app", "docs"]);
    expect(config.repos.docs?.mcp).toEqual([]);
    expect(Object.keys(serversFor(config, "player.games-app"))).toEqual(["linear", "admin"]);
    expect(serversFor(config, "docs")).toEqual({});
    expect(secretsNamedBy(serversFor(config, "player.games-app"))).toEqual([
      "ADMIN_MCP_URL",
      "LINEAR_API_KEY",
    ]);
  });

  it("refuses a server nobody defined, a repo without its GitHub name, and a server of neither shape", () => {
    const repo = "repos:\n  web:\n    github: acme/web\n    description: web\n";
    expect(() => configSetting(`${repo}    mcp: [ghost]\n`)).toThrow(/no MCP server named ghost/);
    expect(() => configSetting("repos:\n  web:\n    description: web\n")).toThrow(/repos\.web\.github/);
    expect(() => configSetting(`${repo}    github: not-a-repo\n`)).toThrow();
    expect(() => configSetting("mcpServers:\n  odd:\n    url: x\n    command: y\n")).toThrow(
      /mcpServers\.odd/,
    );
    expect(() => configSetting(`${repo}    defaults:\n      change: { harness: antigravity }\n`)).toThrow(
      /harness/,
    );
  });

  it("names broken YAML instead of deploying it", () => {
    expect(() => configSetting("repos: [unclosed")).toThrow(/not valid YAML/);
  });

  it("starts from a clean slate: no file and no KILN_CONFIG mean no repos and no servers", () => {
    expect(JSON.parse(configSetting(""))).toEqual({ repos: {}, mcpServers: {} });
    expect(parseDeployment(undefined)).toEqual({ repos: {}, mcpServers: {} });
    expect(parseDeployment("{nope")).toMatch(/not JSON/);
  });
});
