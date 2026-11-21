// Which MCP servers each repo's jobs get. They are this deployment's own
// settings, so they live outside the public code: in kiln.config.yaml
// (gitignored), which `pnpm run deploy` checks and sends to the agent's Vercel
// project as KILN_MCP. The agent hands each job's machine its repo's servers
// and no others. Values may name the repo's secrets as ${NAME}; the worker
// fills them in from the machine's environment, so no secret is in the file.

import { z } from "zod";
import { repos } from "./config.ts";

const text = z.string().min(1);
const record = z.record(z.string(), z.string());

export const McpServerSchema = z.union([
  z.strictObject({ url: text, headers: record.optional() }),
  z.strictObject({ command: text, args: z.array(z.string()).optional(), env: record.optional() }),
]);
export type McpServer = z.infer<typeof McpServerSchema>;

export const McpConfigSchema = z
  .strictObject({
    mcpServers: z
      .record(z.string().regex(/^[a-zA-Z0-9_-]+$/, "letters, digits, - and _"), McpServerSchema)
      .default({}),
    repos: z.record(z.string(), z.strictObject({ mcp: z.array(z.string()).default([]) })).default({}),
  })
  .superRefine((config, ctx) => {
    for (const [repo, { mcp }] of Object.entries(config.repos)) {
      if (!repos[repo]) {
        ctx.addIssue({
          code: "custom",
          path: ["repos", repo],
          message: `${repo} is not a repo in lib/config.ts`,
        });
      }
      for (const name of mcp) {
        if (!config.mcpServers[name]) {
          ctx.addIssue({
            code: "custom",
            path: ["repos", repo, "mcp"],
            message: `no MCP server named ${name}`,
          });
        }
      }
    }
  });
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const EMPTY_MCP: McpConfig = { mcpServers: {}, repos: {} };

/** Parses KILN_MCP. Unset means no MCP servers; anything malformed is an error, never silently ignored. */
export function parseMcpConfig(json: string | undefined): McpConfig | string {
  if (!json) return EMPTY_MCP;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return "KILN_MCP is not JSON; deploy with pnpm run deploy";
  }
  const parsed = McpConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : `KILN_MCP is invalid: ${describeIssues(parsed.error)}`;
}

export function describeIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

/** The MCP servers a repo's jobs get, by name. */
export function serversFor(config: McpConfig, repo: string): Record<string, McpServer> {
  return Object.fromEntries(
    (config.repos[repo]?.mcp ?? []).flatMap((name) => {
      const server = config.mcpServers[name];
      return server ? [[name, server]] : [];
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
