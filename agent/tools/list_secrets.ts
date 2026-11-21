import { defineTool } from "eve/tools";
import { z } from "zod";
import { repos } from "../../lib/config.ts";
import { parseMcpConfig, secretsNamedBy, serversFor } from "../../lib/mcp.ts";
import { secretNames } from "../../lib/secrets.ts";
import { boatClient } from "../lib/machines.ts";

const repoKeys = Object.keys(repos) as [string, ...string[]];

export default defineTool({
  description:
    "List the names of a repo's secrets, its MCP servers, and which secrets those servers need but don't have. Names only; values never leave boat.",
  inputSchema: z.object({ repo: z.enum(repoKeys) }),
  label: false,
  async execute({ repo }) {
    const boat = boatClient();
    if (typeof boat === "string") throw new Error(boat);
    const mcp = parseMcpConfig(process.env.KILN_MCP);
    if (typeof mcp === "string") throw new Error(mcp);
    const servers = serversFor(mcp, repo);
    const set = await secretNames(boat, repo);
    return {
      repo,
      set,
      mcpServers: Object.keys(servers),
      missingForMcp: secretsNamedBy(servers).filter((name) => !set.includes(name)),
    };
  },
});
