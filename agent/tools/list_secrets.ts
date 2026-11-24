import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { hasSecrets, plannedConnections } from "../../lib/agent-connections.ts";
import {
  configuredProjects,
  deployment,
  secretsNamedBy,
  serversFor,
  workerServer,
} from "../../lib/deployment.ts";
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
      "List a repo's or project's secrets by group: each one's name, what it is, who saved it and when, when it " +
      "expires (expiresInDays within two weeks, expired once it has passed), and where it's copied in GitHub " +
      "Actions. Also its MCP servers: which groups hold every secret each needs (a job gets a server only when " +
      "its group does), and, for a server that is also yours, its connection name (find its tools with eve__search), " +
      "whether its secrets are set, and asksFirst when a person approves each call. Names only; values never leave " +
      "boat. For a secret that expires, set yourself a task to remind people before it does.",
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
      const connections = plannedConnections(config).filter((connection) => connection.project === repo);
      const mcpServers = Object.fromEntries(
        Object.entries(servers).map(([key, server]) => {
          const needs = secretsNamedBy({ [key]: workerServer(server) });
          const connection = connections.find((candidate) => candidate.server === key);
          return [
            key,
            {
              needs,
              groups: SECRET_GROUPS.filter((group) => needs.every((name) => names[group].includes(name))),
              ...(connection
                ? {
                    yours: {
                      connection: connection.name,
                      ready: hasSecrets(connection, names),
                      ...(connection.approval === "always" ? { asksFirst: true } : {}),
                    },
                  }
                : {}),
            },
          ];
        }),
      );
      return { repo, groups, mcpServers };
    },
  });
});
