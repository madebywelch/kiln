import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { configuredProjects, deployment, secretsNamedBy, serversFor } from "../../lib/deployment.ts";
import { secretNames } from "../../lib/secrets.ts";
import { boatClient } from "../lib/machines.ts";

export default defineDynamic(() => {
  const projects = configuredProjects();
  if (!projects) return null;
  const repoKeys = Object.keys(projects) as [string, ...string[]];

  return defineTool({
    description:
      "List the names of a repo's or project's secrets, its MCP servers, and which secrets those servers need but don't have. Names only; values never leave boat.",
    inputSchema: z.object({ repo: z.enum(repoKeys) }),
    label: false,
    async execute({ repo }) {
      const boat = boatClient();
      if (typeof boat === "string") throw new Error(boat);
      const config = deployment();
      if (typeof config === "string") throw new Error(config);
      const servers = serversFor(config, repo);
      const set = await secretNames(boat, repo);
      return {
        repo,
        set,
        mcpServers: Object.keys(servers),
        missingForMcp: secretsNamedBy(servers).filter((name) => !set.includes(name)),
      };
    },
  });
});
