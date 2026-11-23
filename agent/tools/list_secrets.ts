import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { configuredProjects, deployment, secretsNamedBy, serversFor } from "../../lib/deployment.ts";
import { describeCopy } from "../../lib/github-secrets.ts";
import { daysUntil, EXPIRY_WARNING_DAYS, readSecretLabels } from "../../lib/secret-labels.ts";
import { environmentName, SECRET_GROUPS, secretNamesByGroup } from "../../lib/secrets.ts";
import { secretLabelStore } from "../lib/drive.ts";
import { boatClient } from "../lib/machines.ts";

export default defineDynamic(() => {
  const projects = configuredProjects();
  if (!projects) return null;
  const repoKeys = Object.keys(projects) as [string, ...string[]];

  return defineTool({
    description:
      "List a repo's or project's secrets by group: each one's name, what it is, who saved it and when, and when it " +
      "expires (expiresInDays when it's within two weeks, expired once it has passed), and where it's copied in GitHub " +
      "Actions. Also its MCP servers and which " +
      "group can sign in to each: a job gets a server only when its group holds every secret the server needs. Names " +
      "only; values never leave boat. For a secret that expires, set yourself a task to remind people before it does.",
    inputSchema: z.object({ repo: z.enum(repoKeys) }),
    label: false,
    async execute({ repo }) {
      const boat = boatClient();
      if (typeof boat === "string") throw new Error(boat);
      const config = deployment();
      if (typeof config === "string") throw new Error(config);
      const [names, labels] = await Promise.all([
        secretNamesByGroup(boat, repo),
        readSecretLabels(secretLabelStore()),
      ]);
      const now = Date.now();
      const groups = Object.fromEntries(
        SECRET_GROUPS.map((group) => {
          const about = labels[environmentName(repo, group)] ?? {};
          return [
            group,
            names[group].map((name) => {
              const label = about[name];
              if (!label) return { name, description: null };
              const days = label.expires ? daysUntil(label.expires, now) : undefined;
              return {
                name,
                description: label.description || null,
                ...(label.savedBy
                  ? { savedBy: `<@${label.savedBy}>`, savedAt: label.savedAt.slice(0, 10) }
                  : {}),
                ...(label.expires ? { expires: label.expires } : {}),
                ...(days !== undefined && days < 0 ? { expired: true } : {}),
                ...(days !== undefined && days >= 0 && days <= EXPIRY_WARNING_DAYS
                  ? { expiresInDays: days }
                  : {}),
                ...(label.github?.length ? { github: label.github.map(describeCopy) } : {}),
              };
            }),
          ];
        }),
      );
      const servers = serversFor(config, repo);
      const mcpServers = Object.fromEntries(
        Object.entries(servers).map(([key, server]) => {
          const needs = secretsNamedBy({ [key]: server });
          return [
            key,
            {
              needs,
              groups: SECRET_GROUPS.filter((group) => needs.every((name) => names[group].includes(name))),
            },
          ];
        }),
      );
      return { repo, groups, mcpServers };
    },
  });
});
