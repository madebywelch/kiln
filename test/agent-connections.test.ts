import { describe, expect, it } from "vitest";
import {
  agentHeaders,
  connectionName,
  connectionNameIssues,
  filledHeaders,
  hasSecrets,
  plannedConnections,
  unsetAgentSecrets,
} from "../lib/agent-connections.ts";
import { type Deployment, DeploymentSchema, serversFor, workerServer } from "../lib/deployment.ts";
import { groupOfSecret } from "../lib/secrets.ts";

const deployment = (raw: unknown): Deployment => DeploymentSchema.parse(raw);

const config = deployment({
  repos: {
    "web.app": { github: "acme/web", description: "the site", mcp: ["sentry", "admin", "linear"] },
    api: { github: "acme/api", description: "the API", mcp: ["sentry"] },
  },
  mcpServers: {
    sentry: {
      url: "https://mcp.sentry.dev/mcp?skills=inspect",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
      headers: { Authorization: "Sentry-Bearer ${PROD_READ_SENTRY_TOKEN}" },
      description: "Sentry: errors and their events.",
      agent: true,
    },
    admin: {
      url: "https://admin.example.com/mcp",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
      headers: { Authorization: "Bearer ${PROD_WRITE_ADMIN_TOKEN}" },
      description: "The admin panel.",
      agent: { tools: { allow: ["list_users"] } },
    },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
    linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } },
  },
});

describe("plannedConnections", () => {
  it("makes each agent server a connection per project that lists it, and leaves the rest to jobs", () => {
    const planned = plannedConnections(config);
    expect(planned.map((c) => c.name).sort()).toEqual(["admin-web-app", "sentry-api", "sentry-web-app"]);
    const sentry = planned.find((c) => c.name === "sentry-web-app");
    expect(sentry).toMatchObject({
      project: "web.app",
      server: "sentry",
      secrets: ["PROD_READ_SENTRY_TOKEN"],
      approval: "never",
      description: "Sentry: errors and their events. For web.app: the site",
    });
    expect(sentry?.tools).toBeUndefined();
  });

  it("asks a person before every call to a server whose secrets can change production, and keeps its tool filter", () => {
    const admin = plannedConnections(config).find((c) => c.name === "admin-web-app");
    expect(admin).toMatchObject({ approval: "always", tools: { allow: ["list_users"] } });
  });

  it("names connections as eve allows, and refuses names that are too long at deploy", () => {
    expect(connectionName("sentry", "player.games-app")).toBe("sentry-player-games-app");
    expect(connectionName("1x", "web")).toBe("mcp-1x-web");
    const long = deployment({
      repos: { ["p".repeat(60)]: { github: "a/b", description: "d", mcp: ["sentry"] } },
      mcpServers: { sentry: { url: "https://s", description: "S", agent: true } },
    });
    expect(connectionNameIssues(long)).toHaveLength(1);
    expect(plannedConnections(long)).toEqual([]);
    expect(connectionNameIssues(config)).toEqual([]);
  });
});

describe("hasSecrets and filledHeaders", () => {
  const sentry = plannedConnections(config).find((c) => c.name === "sentry-web-app");
  if (!sentry) throw new Error("no sentry connection");

  it("offers a connection only once every secret it names is set in its group", () => {
    const none = { staging: [], "production-read": [], "production-write": [] };
    expect(hasSecrets(sentry, none)).toBe(false);
    expect(hasSecrets(sentry, { ...none, staging: ["PROD_READ_SENTRY_TOKEN"] })).toBe(false);
    expect(hasSecrets(sentry, { ...none, "production-read": ["PROD_READ_SENTRY_TOKEN"] })).toBe(true);
  });

  it("fills the header from the project's group in boat, and names a missing secret without any value", () => {
    const environments = [
      { name: "kiln-web.app-production-read", envContents: "PROD_READ_SENTRY_TOKEN=sntrys_abc123\nOTHER=x" },
      { name: "kiln-api-production-read", envContents: "PROD_READ_SENTRY_TOKEN=other-projects-token" },
    ];
    expect(filledHeaders(sentry, environments)).toEqual({ Authorization: "Sentry-Bearer sntrys_abc123" });
    expect(() => filledHeaders(sentry, environments.slice(1))).toThrow(
      "PROD_READ_SENTRY_TOKEN isn't in web.app's production-read secrets",
    );
  });
});

describe("agent servers in kiln.config.yaml", () => {
  const parse = (server: unknown) =>
    DeploymentSchema.safeParse({
      repos: { web: { github: "a/b", description: "d", mcp: ["s"] } },
      mcpServers: { s: server },
    });

  it("need a description, and a url that names no secret", () => {
    expect(parse({ url: "https://s", agent: true }).error?.message).toContain("needs a description");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
    expect(parse({ url: "https://s?key=${KEY}", description: "S", agent: true }).error?.message).toContain(
      "url can't name a secret",
    );
    expect(parse({ command: "npx", agent: true }).success).toBe(false);
    expect(parse({ url: "https://s", description: "S", agent: { tools: { allow: ["a"] } } }).success).toBe(
      true,
    );
  });

  it("reach a job's machine without what only the agent uses", () => {
    expect(workerServer({ url: "https://s", headers: { A: "b" }, description: "S", agent: true })).toEqual({
      url: "https://s",
      headers: { A: "b" },
    });
  });
});

describe("everywhere servers", () => {
  const withMemory = deployment({
    repos: { web: { github: "acme/web", description: "the site", mcp: ["linear"] } },
    mcpServers: {
      memory: {
        url: "https://memory.example.com/mcp",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
        headers: { Authorization: "Bearer ${MCP_MEMORY_API_KEY}" },
        description: "Long-term memory, searched by meaning.",
        agent: { everywhere: true, tools: { block: ["delete_all"] } },
      },
      // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
      linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } },
    },
  });
  const memory = plannedConnections(withMemory).find((c) => c.name === "memory");
  if (!memory) throw new Error("no memory connection");

  it("are one connection named for the server, listed on no project, and never a job's", () => {
    expect(plannedConnections(withMemory)).toHaveLength(1);
    expect(memory).toMatchObject({
      project: null,
      server: "memory",
      secrets: ["MCP_MEMORY_API_KEY"],
      approval: "never",
      description: "Long-term memory, searched by meaning.",
      tools: { block: ["delete_all"] },
    });
    expect(serversFor(withMemory, "web")).not.toHaveProperty("memory");
  });

  it("are offered only once every secret is set on the agent, and filled from its environment", () => {
    expect(unsetAgentSecrets(memory, {})).toEqual(["MCP_MEMORY_API_KEY"]);
    expect(unsetAgentSecrets(memory, { MCP_MEMORY_API_KEY: "" })).toEqual(["MCP_MEMORY_API_KEY"]);
    expect(unsetAgentSecrets(memory, { MCP_MEMORY_API_KEY: "m0-abc" })).toEqual([]);
    expect(agentHeaders(memory, { MCP_MEMORY_API_KEY: "m0-abc" })).toEqual({
      Authorization: "Bearer m0-abc",
    });
    expect(() => agentHeaders(memory, {})).toThrow(
      "MCP_MEMORY_API_KEY isn't set on the agent's Vercel project",
    );
  });

  it("never read a project's boat secrets", () => {
    const all = { staging: ["MCP_MEMORY_API_KEY"], "production-read": [], "production-write": [] };
    expect(hasSecrets(memory, all)).toBe(false);
    expect(() => filledHeaders(memory, [])).toThrow("use agentHeaders");
  });

  it("ask a person before every call when a secret can change production", () => {
    const admin = deployment({
      mcpServers: {
        admin: {
          url: "https://admin.example.com/mcp",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
          headers: { Authorization: "Bearer ${MCP_PROD_WRITE_ADMIN_TOKEN}" },
          description: "The admin panel.",
          agent: { everywhere: true },
        },
      },
    });
    expect(plannedConnections(admin)[0]).toMatchObject({ name: "admin", approval: "always" });
  });

  it("can't take a name another connection has", () => {
    const clash = deployment({
      repos: { web: { github: "a/b", description: "d", mcp: ["sentry"] } },
      mcpServers: {
        sentry: { url: "https://s", description: "S", agent: true },
        "sentry-web": { url: "https://t", description: "T", agent: { everywhere: true } },
      },
    });
    expect(connectionNameIssues(clash)).toEqual([
      "sentry on web: its connection name sentry-web is taken by another connection",
    ]);
  });

  it("must name only MCP_ variables, so kiln's own credentials can't reach a server", () => {
    const parse = (headers: Record<string, string>) =>
      DeploymentSchema.safeParse({
        mcpServers: { m: { url: "https://m", headers, description: "M", agent: { everywhere: true } } },
      });
    // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
    expect(parse({ Authorization: "Bearer ${BOARD_TOKEN}" }).error?.message).toContain("rename BOARD_TOKEN");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: how kiln.config.yaml names a server's secret
    expect(parse({ Authorization: "Bearer ${MCP_M_KEY}" }).success).toBe(true);
  });

  it("can't be listed on a repo or project", () => {
    const listed = DeploymentSchema.safeParse({
      repos: { web: { github: "a/b", description: "d", mcp: ["m"] } },
      mcpServers: { m: { url: "https://m", description: "M", agent: { everywhere: true } } },
    });
    expect(listed.error?.message).toContain("jobs never get it");
  });
});

describe("groupOfSecret", () => {
  it("reads a secret's group from its name", () => {
    expect(groupOfSecret("PROD_WRITE_DEPLOY_TOKEN")).toBe("production-write");
    expect(groupOfSecret("PROD_READ_DATABASE_URL")).toBe("production-read");
    expect(groupOfSecret("DATABASE_URL")).toBe("staging");
  });
});
