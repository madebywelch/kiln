import { describe, expect, it } from "vitest";
import { parseMcpConfig, secretsNamedBy, serversFor } from "../lib/mcp.ts";
import { mcpSetting } from "../scripts/deploy.ts";

const yaml = `
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
repos:
  player.games-app:
    mcp: [linear, admin]
`;

describe("kiln.config.yaml", () => {
  it("becomes KILN_MCP, and each repo gets only the servers it lists", () => {
    const config = parseMcpConfig(mcpSetting(yaml));
    if (typeof config === "string") throw new Error(config);
    expect(Object.keys(serversFor(config, "player.games-app"))).toEqual(["linear", "admin"]);
    expect(serversFor(config, "another-repo")).toEqual({});
    expect(secretsNamedBy(serversFor(config, "player.games-app"))).toEqual([
      "ADMIN_MCP_URL",
      "LINEAR_API_KEY",
    ]);
  });

  it("refuses a repo kiln doesn't know, a server nobody defined, and a server of neither shape", () => {
    expect(() => mcpSetting("repos:\n  someone-else:\n    mcp: []\n")).toThrow(/someone-else is not a repo/);
    expect(() => mcpSetting("repos:\n  player.games-app:\n    mcp: [ghost]\n")).toThrow(
      /no MCP server named ghost/,
    );
    expect(() => mcpSetting("mcpServers:\n  odd:\n    url: x\n    command: y\n")).toThrow(/mcpServers\.odd/);
  });

  it("names broken YAML instead of deploying it", () => {
    expect(() => mcpSetting("mcpServers: [unclosed")).toThrow(/not valid YAML/);
  });

  it("treats an empty file and an unset KILN_MCP as no servers, and a garbled one as an error", () => {
    expect(JSON.parse(mcpSetting(""))).toEqual({ mcpServers: {}, repos: {} });
    expect(parseMcpConfig(undefined)).toEqual({ mcpServers: {}, repos: {} });
    expect(parseMcpConfig("{nope")).toMatch(/not JSON/);
    expect(parseMcpConfig('{"repos":{"x":{"mcp":[]}}}')).toMatch(/x is not a repo/);
  });
});
