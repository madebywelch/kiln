import { describe, expect, it } from "vitest";
import { agentName, parseDeployment, projectsOf, secretsNamedBy, serversFor } from "../lib/deployment.ts";
import { configSetting } from "../scripts/deploy.ts";

const yaml = `
repos:
  web:
    github: acme/web
    description: The marketing site and the customer dashboard.
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
    expect(Object.keys(config.repos)).toEqual(["web", "docs"]);
    expect(config.repos.docs?.mcp).toEqual([]);
    expect(Object.keys(serversFor(config, "web"))).toEqual(["linear", "admin"]);
    expect(serversFor(config, "docs")).toEqual({});
    expect(secretsNamedBy(serversFor(config, "web"))).toEqual(["ADMIN_MCP_URL", "LINEAR_API_KEY"]);
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
    expect(JSON.parse(configSetting(""))).toEqual({ repos: {}, projects: {}, mcpServers: {} });
    expect(parseDeployment(undefined)).toEqual({ repos: {}, projects: {}, mcpServers: {} });
    expect(parseDeployment("{nope")).toMatch(/not JSON/);
  });
});

const projectYaml = `
repos:
  shop:
    github: acme/shop
    description: The app.
  shop-cloud:
    github: acme/shop-cloud
    description: The hosted service.
    baseBranch: dev
  docs:
    github: acme/docs
    description: The docs site.
    mcp: [linear]
projects:
  shop:
    description: Shop, app and cloud.
    repos: [shop, shop-cloud]
    defaults:
      change: { effort: max }
    mcp: [linear]
mcpServers:
  linear:
    url: https://mcp.linear.app/mcp
`;

describe("projects", () => {
  it("are what jobs run on: each project, and each repo in none as its own, keyed for jobs and secrets", () => {
    const config = parseDeployment(configSetting(projectYaml));
    if (typeof config === "string") throw new Error(config);
    const projects = projectsOf(config);
    expect(Object.keys(projects)).toEqual(["docs", "shop"]);
    expect(projects.shop?.repos).toEqual([
      { key: "shop", github: "acme/shop", baseBranch: undefined, description: "The app." },
      {
        key: "shop-cloud",
        github: "acme/shop-cloud",
        baseBranch: "dev",
        description: "The hosted service.",
      },
    ]);
    expect(projects.shop?.defaults).toEqual({ change: { effort: "max" } });
    expect(projects.docs?.repos.map((repo) => repo.key)).toEqual(["docs"]);
    expect(Object.keys(serversFor(config, "shop"))).toEqual(["linear"]);
  });

  it("refuse a missing repo, a repo in two projects, member settings that would be ignored, and a clash with a repo", () => {
    const repos =
      "repos:\n  a:\n    github: acme/a\n    description: a\n  b:\n    github: acme/b\n    description: b\n";
    const project = (name: string, members: string) =>
      `  ${name}:\n    description: ${name}\n    repos: [${members}]\n`;
    expect(() => configSetting(`${repos}projects:\n${project("p", "a, ghost")}`)).toThrow(
      /no repo named ghost/,
    );
    expect(() => configSetting(`${repos}projects:\n${project("p", "a, b")}${project("q", "a, b")}`)).toThrow(
      /already in project p/,
    );
    expect(() => configSetting(`${repos}projects:\n${project("p", "a")}`)).toThrow(/at least two repos/);
    expect(() =>
      configSetting(
        `${repos}  c:\n    github: acme/c\n    description: c\nprojects:\n${project("c2", "a, b")}${project("c", "a2")}`,
      ),
    ).toThrow();
    const clash = `${repos}  c:\n    github: acme/c\n    description: c\nprojects:\n${project("c", "a, b")}`;
    expect(() => configSetting(clash)).toThrow(/also a repo outside this project/);
    const memberMcp = `repos:\n  a:\n    github: acme/a\n    description: a\n    mcp: [linear]\n  b:\n    github: acme/b\n    description: b\nprojects:\n${project("p", "a, b")}mcpServers:\n  linear:\n    url: x\n`;
    expect(() => configSetting(memberMcp)).toThrow(/set its defaults and mcp on the project/);
  });
});

describe("the agent's name", () => {
  it("comes from the machine's KILN_AGENT_NAME, then kiln.config.yaml, then eve; kiln's code names no agent", () => {
    expect(agentName({ KILN_AGENT_NAME: "Mabel", KILN_CONFIG: JSON.stringify({ name: "Other" }) })).toBe(
      "Mabel",
    );
    expect(agentName({ KILN_CONFIG: JSON.stringify({ name: "Other" }) })).toBe("Other");
    expect(agentName({})).toBe("eve");
    expect(() => configSetting('name: "<script>"\n')).toThrow(/name/);
  });
});
