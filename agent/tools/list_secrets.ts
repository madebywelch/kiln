import { defineTool } from "eve/tools";
import { z } from "zod";
import { mcpServers, repos } from "../../lib/config.ts";
import { secretNames } from "../../lib/secrets.ts";
import { boatClient } from "../lib/machines.ts";

const repoKeys = Object.keys(repos) as [string, ...string[]];

/** The ${NAME} references in a repo's MCP servers: secrets its jobs can't start without. */
function mcpNeeds(repo: string): string[] {
  const names = new Set<string>();
  for (const server of repos[repo]?.mcp ?? []) {
    for (const match of JSON.stringify(mcpServers[server] ?? {}).matchAll(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    )) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

export default defineTool({
  description:
    "List the names of a repo's secrets, and which ones its MCP servers need but don't have. Names only; values never leave boat.",
  inputSchema: z.object({ repo: z.enum(repoKeys) }),
  label: false,
  async execute({ repo }) {
    const boat = boatClient();
    if (typeof boat === "string") throw new Error(boat);
    const set = await secretNames(boat, repo);
    const missing = mcpNeeds(repo).filter((name) => !set.includes(name));
    return { repo, set, missingForMcp: missing };
  },
});
