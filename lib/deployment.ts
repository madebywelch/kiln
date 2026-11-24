// This deployment's own settings: the agent's name, which repos kiln works on,
// the projects that group them, and the MCP servers their jobs get. They are
// nobody else's business, so they live outside the public code, in
// kiln.config.yaml (gitignored), which `pnpm run deploy` checks and sends to the
// agent's Vercel project as KILN_CONFIG. Out of the box there are none: kiln
// names no agent, no repos, and no servers.
//
// A job runs on a project: the repos it clones side by side, so one change can
// span them. A repo in no project is a project of its own. Jobs, defaults, MCP
// servers, and secrets are keyed by the project.
//
// MCP values may name the repo's secrets as ${NAME}; the worker fills them in
// from the machine's environment, so no secret is in the file. A hosted server
// marked `agent` is also the agent's own connection, once per project that
// lists it (lib/agent-connections.ts); kiln fills its ${NAME}s from boat.

import { z } from "zod";
import { EFFORTS, HARNESSES, KINDS } from "./config.ts";

const text = z.string().min(1);
const strings = z.record(z.string(), z.string());

/** Which of a server's tools the agent sees: exactly one of `allow` or `block`, by tool name. */
const ToolFilterSchema = z.union([
  z.strictObject({ allow: z.array(text).min(1) }),
  z.strictObject({ block: z.array(text).min(1) }),
]);
export type ToolFilter = z.infer<typeof ToolFilterSchema>;

export const McpServerSchema = z.union([
  z.strictObject({
    url: text,
    headers: strings.optional(),
    /** What the server is for, in a sentence: the agent reads it to pick a connection. Needed with `agent`. */
    description: text.optional(),
    /** Also the agent's own connection, for every project that lists the server; optionally only some tools. */
    agent: z.union([z.literal(true), z.strictObject({ tools: ToolFilterSchema })]).optional(),
  }),
  z.strictObject({ command: text, args: z.array(z.string()).optional(), env: strings.optional() }),
]);
export type McpServer = z.infer<typeof McpServerSchema>;

/** A server as a job's machine gets it: without what only the agent uses. */
export function workerServer(server: McpServer): McpServer {
  if (!("url" in server)) return server;
  const { agent: _agent, description: _description, ...rest } = server;
  return rest;
}

const SelectionOverride = z.strictObject({
  harness: z.enum(HARNESSES).optional(),
  model: text.optional(),
  effort: z.enum(EFFORTS).optional(),
});

export const RepoSchema = z.strictObject({
  /** `owner/name` on GitHub. */
  github: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "owner/name"),
  /** What the repo is, in the words people use for it. The agent maps conversation to repos with this. */
  description: text,
  /** Branch that job branches start from and pull requests target. Default `main`. */
  baseBranch: text.optional(),
  /** Overrides of the global defaults for jobs on this repo, by kind of job. */
  defaults: z.partialRecord(z.enum(KINDS), SelectionOverride).optional(),
  /** Names from `mcpServers` that jobs on this repo get. */
  mcp: z.array(z.string()).default([]),
});
export type RepoConfig = z.input<typeof RepoSchema>;

export const ProjectSchema = z.strictObject({
  /** What the project is, in the words people use for it. */
  description: text,
  /** Keys from `repos`, cloned side by side for every job on the project. */
  repos: z.array(z.string()).min(2, "a project groups at least two repos"),
  /** Overrides of the global defaults for the project's jobs, by kind of job. */
  defaults: z.partialRecord(z.enum(KINDS), SelectionOverride).optional(),
  /** Names from `mcpServers` that the project's jobs get. */
  mcp: z.array(z.string()).default([]),
});

/** The agent's name when kiln.config.yaml gives none. */
export const DEFAULT_AGENT_NAME = "eve";

const name = (what: string) => z.string().regex(/^[a-zA-Z0-9._-]+$/, `${what}: letters, digits, ., - and _`);

export const DeploymentSchema = z
  .strictObject({
    /** The agent's name: what it is called in Slack, answers to without an @mention, and signs work with. */
    name: z
      .string()
      .regex(/^[A-Za-z0-9][\w .-]{0,34}$/, "up to 35 letters, digits, spaces, and . _ -")
      .optional(),
    repos: z.record(name("repo"), RepoSchema).default({}),
    projects: z.record(name("project"), ProjectSchema).default({}),
    mcpServers: z.record(name("server"), McpServerSchema).default({}),
  })
  .superRefine((config, ctx) => {
    const checkServers = (path: (string | number)[], mcp: readonly string[]) => {
      for (const server of mcp) {
        if (!config.mcpServers[server]) {
          ctx.addIssue({ code: "custom", path, message: `no MCP server named ${server}` });
        }
      }
    };
    for (const [key, server] of Object.entries(config.mcpServers)) {
      if (!("url" in server) || !server.agent) continue;
      const path = ["mcpServers", key];
      if (!server.description)
        ctx.addIssue({
          code: "custom",
          path,
          message: "an agent server needs a description the agent can choose it by",
        });
      if (/\$\{/.test(server.url))
        ctx.addIssue({
          code: "custom",
          path,
          message: "an agent server's url can't name a secret; put it in a header",
        });
    }
    for (const [repo, { mcp }] of Object.entries(config.repos)) checkServers(["repos", repo, "mcp"], mcp);
    const inProject = new Map<string, string>();
    for (const [project, { repos, mcp }] of Object.entries(config.projects)) {
      checkServers(["projects", project, "mcp"], mcp);
      for (const repo of repos) {
        const path = ["projects", project, "repos"];
        const member = config.repos[repo];
        if (!member) ctx.addIssue({ code: "custom", path, message: `no repo named ${repo}` });
        else if (inProject.has(repo)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `${repo} is already in project ${inProject.get(repo)}`,
          });
        } else if (member.defaults || member.mcp.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["repos", repo],
            message: `${repo} is in project ${project}: set its defaults and mcp on the project`,
          });
        }
        inProject.set(repo, project);
      }
    }
    for (const project of Object.keys(config.projects)) {
      if (config.repos[project] && inProject.get(project) !== project) {
        ctx.addIssue({
          code: "custom",
          path: ["projects", project],
          message: `${project} is also a repo outside this project; jobs couldn't tell them apart`,
        });
      }
    }
  });
export type Deployment = z.infer<typeof DeploymentSchema>;

export const EMPTY_DEPLOYMENT: Deployment = { repos: {}, projects: {}, mcpServers: {} };

/** One repo a job clones: its key in kiln.config.yaml, GitHub name, and base branch. */
export interface ProjectRepo {
  readonly key: string;
  readonly github: string;
  readonly baseBranch?: string | undefined;
  readonly description: string;
}

/** What a job runs on: one repo, or a project's repos side by side. */
export interface Project {
  readonly description: string;
  readonly repos: readonly ProjectRepo[];
  readonly defaults?: RepoConfig["defaults"];
  readonly mcp: readonly string[];
}

/** Every project jobs can run on, by key: the configured projects, and each repo in none as its own. */
export function projectsOf(config: Deployment): Record<string, Project> {
  const repo = (key: string): ProjectRepo => {
    const { github, baseBranch, description } = config.repos[key] as z.infer<typeof RepoSchema>;
    return { key, github, baseBranch, description };
  };
  const grouped = new Set(Object.values(config.projects).flatMap((project) => project.repos));
  const projects: Record<string, Project> = {};
  for (const [key, { description, defaults, mcp }] of Object.entries(config.repos)) {
    if (!grouped.has(key)) projects[key] = { description, repos: [repo(key)], defaults, mcp };
  }
  for (const [key, { description, repos, defaults, mcp }] of Object.entries(config.projects)) {
    projects[key] = { description, repos: repos.map(repo), defaults, mcp };
  }
  return projects;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** Parses KILN_CONFIG. Unset means a clean slate; anything malformed is an error, never silently ignored. */
export function parseDeployment(json: string | undefined): Deployment | string {
  if (!json) return EMPTY_DEPLOYMENT;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return "KILN_CONFIG is not JSON; deploy with pnpm run deploy";
  }
  const parsed = DeploymentSchema.safeParse(raw);
  return parsed.success ? parsed.data : `KILN_CONFIG is invalid: ${describeIssues(parsed.error)}`;
}

let cached: { readonly json: string | undefined; readonly value: Deployment | string } | undefined;

/** This deployment's settings from the environment, parsed once per value. */
export function deployment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Deployment | string {
  const json = env.KILN_CONFIG;
  const hit = cached;
  if (hit && hit.json === json) return hit.value;
  const value = parseDeployment(json);
  cached = { json, value };
  return value;
}

/** The projects jobs can run on, or null when there are none or the config is broken (and says why in the log). */
export function configuredProjects(): Record<string, Project> | null {
  const config = deployment();
  if (typeof config === "string") {
    console.error(JSON.stringify({ event: "deployment.invalid", problem: config }));
    return null;
  }
  const projects = projectsOf(config);
  return Object.keys(projects).length > 0 ? projects : null;
}

/**
 * The agent's name: KILN_AGENT_NAME on a job's machine, else kiln.config.yaml's `name`, else
 * DEFAULT_AGENT_NAME. kiln's code never names the agent.
 */
export function agentName(env: Readonly<Record<string, string | undefined>> = process.env): string {
  if (env.KILN_AGENT_NAME) return env.KILN_AGENT_NAME;
  const config = deployment(env);
  return (typeof config !== "string" && config.name) || DEFAULT_AGENT_NAME;
}

/** The MCP servers a project's jobs get, by name. */
export function serversFor(config: Deployment, project: string): Record<string, McpServer> {
  return Object.fromEntries(
    (projectsOf(config)[project]?.mcp ?? []).flatMap((server) => {
      const definition = config.mcpServers[server];
      return definition ? [[server, definition]] : [];
    }),
  );
}

/** The secrets a project's MCP servers name as ${NAME}. */
export function secretsNamedBy(servers: Readonly<Record<string, McpServer>>): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(servers).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}
