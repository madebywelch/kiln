// The agent's own MCP connections: each hosted server in kiln.config.yaml
// marked `agent`, once per project that lists it (lib/agent-connections.ts).
// Its secrets are filled into its headers from boat when a call is made, here
// in the agent's function: the model never sees them, and eve's saved state
// holds only which names are set. A connection whose secrets aren't all set
// isn't offered. An everywhere server is one connection in every conversation,
// filled from the agent's own environment instead, so it needs no boat.

import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { always, never } from "eve/tools/approval";
import {
  agentHeaders,
  filledHeaders,
  hasSecrets,
  type PlannedConnection,
  plannedConnections,
  unsetAgentSecrets,
} from "../../lib/agent-connections.ts";
import type { Environment } from "../../lib/boat.ts";
import { deployment } from "../../lib/deployment.ts";
import { type SecretGroup, secretNamesByGroup } from "../../lib/secrets.ts";
import { boatClient, log } from "../lib/machines.ts";

/** How long secret values read from boat are reused, so each call doesn't list every environment again. */
const VALUES_TTL_MS = 60_000;
let values: { readonly at: number; readonly environments: Promise<readonly Environment[]> } | undefined;

function environments(): Promise<readonly Environment[]> {
  const boat = boatClient();
  if (typeof boat === "string") return Promise.reject(new Error(boat));
  const now = Date.now();
  if (!values || now - values.at > VALUES_TTL_MS) {
    const fetched = boat.environments();
    fetched.catch(() => {
      if (values?.environments === fetched) values = undefined;
    });
    values = { at: now, environments: fetched };
  }
  return values.environments;
}

/** Everywhere connections already logged as missing a secret, so each is logged once per instance. */
const reportedUnset = new Set<string>();

/** Everywhere connections whose secrets are all set on the agent's Vercel project. */
function everywhereReady(planned: readonly PlannedConnection[]): PlannedConnection[] {
  return planned.filter((connection) => {
    const unset = unsetAgentSecrets(connection, process.env);
    if (unset.length > 0 && !reportedUnset.has(connection.name)) {
      reportedUnset.add(connection.name);
      log("connections.secrets_unset", { connection: connection.name, unset });
    }
    return unset.length === 0;
  });
}

export default defineDynamic(async (ctx) => {
  const config = deployment();
  if (typeof config === "string") return null;
  const planned = plannedConnections(config);
  const ready = everywhereReady(planned.filter((connection) => connection.project === null));
  const perProject = planned.filter((connection) => connection.project !== null);
  const boat = boatClient();
  if (perProject.length > 0 && typeof boat !== "string") {
    const projects = [...new Set(perProject.map((connection) => connection.project as string))];
    try {
      // Names only, once per turn: eve saves what a memo returns.
      const names: Record<string, Record<SecretGroup, string[]>> = await ctx.memo(
        `kiln-connections:${ctx.turn?.id ?? "start"}`,
        async () =>
          Object.fromEntries(
            await Promise.all(
              projects.map(async (project) => [project, await secretNamesByGroup(boat, project)]),
            ),
          ),
      );
      ready.push(
        ...perProject.filter((connection) => {
          const have = names[connection.project as string];
          return have !== undefined && hasSecrets(connection, have);
        }),
      );
    } catch (error) {
      // Without boat the agent still works, without its projects' connections this turn.
      log("connections.unavailable", { error: String(error) });
    }
  }
  if (ready.length === 0) return null;
  return Object.fromEntries(
    ready.map((connection) => [
      connection.name,
      defineMcpClientConnection({
        url: connection.url,
        description: connection.description,
        // A project's key holds no "/", so an everywhere server's bare name can't collide.
        instanceKey:
          connection.project === null ? connection.server : `${connection.project}/${connection.server}`,
        headers: async () =>
          connection.project === null
            ? agentHeaders(connection, process.env)
            : filledHeaders(connection, await environments()),
        approval: connection.approval === "always" ? always() : never(),
        ...(connection.tools ? { tools: connection.tools } : {}),
      }),
    ]),
  );
});
