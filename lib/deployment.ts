// This deployment's own settings: which repos kiln works on, and the MCP
// servers each repo's jobs get. They are nobody else's business, so they live
// outside the public code, in kiln.config.yaml (gitignored), which `pnpm run
// deploy` checks and sends to the agent's Vercel project as KILN_CONFIG. Out of
// the box there are none: kiln names no repos and no servers.
//
// MCP values may name the repo's secrets as ${NAME}; the worker fills them in
// from the machine's environment, so no secret is in the file.

import { z } from "zod";
import { EFFORTS, HARNESSES, KINDS } from "./config.ts";

const text = z.string().min(1);
const strings = z.record(z.string(), z.string());

export const McpServerSchema = z.union([
  z.strictObject({ url: text, headers: strings.optional() }),
  z.strictObject({ command: text, args: z.array(z.string()).optional(), env: strings.optional() }),
]);
export type McpServer = z.infer<typeof McpServerSchema>;

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

const name = (what: string) => z.string().regex(/^[a-zA-Z0-9._-]+$/, `${what}: letters, digits, ., - and _`);

export const DeploymentSchema = z
  .strictObject({
    repos: z.record(name("repo"), RepoSchema).default({}),
    mcpServers: z.record(name("server"), McpServerSchema).default({}),
  })
  .superRefine((config, ctx) => {
    for (const [repo, { mcp }] of Object.entries(config.repos)) {
      for (const server of mcp) {
        if (!config.mcpServers[server]) {
          ctx.addIssue({
            code: "custom",
            path: ["repos", repo, "mcp"],
            message: `no MCP server named ${server}`,
          });
        }
      }
    }
  });
export type Deployment = z.infer<typeof DeploymentSchema>;

export const EMPTY_DEPLOYMENT: Deployment = { repos: {}, mcpServers: {} };

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

/** The configured repos, or null when there are none or the config is broken (and says why in the log). */
export function configuredRepos(): Deployment["repos"] | null {
  const config = deployment();
  if (typeof config === "string") {
    console.error(JSON.stringify({ event: "deployment.invalid", problem: config }));
    return null;
  }
  return Object.keys(config.repos).length > 0 ? config.repos : null;
}

/** The MCP servers a repo's jobs get, by name. */
export function serversFor(config: Deployment, repo: string): Record<string, McpServer> {
  return Object.fromEntries(
    (config.repos[repo]?.mcp ?? []).flatMap((server) => {
      const definition = config.mcpServers[server];
      return definition ? [[server, definition]] : [];
    }),
  );
}

/** The secrets a repo's MCP servers name as ${NAME}. */
export function secretsNamedBy(servers: Readonly<Record<string, McpServer>>): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(servers).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}
