// The agent's own MCP connections: each hosted server in kiln.config.yaml
// marked `agent`, once per project that lists it (lib/agent-connections.ts).
// Its secrets are filled into its headers from boat when a call is made, here
// in the agent's function: the model never sees them, and eve's saved state
// holds only which names are set. A connection whose secrets aren't all set
// isn't offered.

import { defineDynamic, defineMcpClientConnection } from "eve/connections";
import { always, never } from "eve/tools/approval";
import { filledHeaders, hasSecrets, plannedConnections } from "../../lib/agent-connections.ts";
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

export default defineDynamic(async (ctx) => {
  const config = deployment();
  if (typeof config === "string") return null;
  const planned = plannedConnections(config);
  if (planned.length === 0) return null;
  const boat = boatClient();
  if (typeof boat === "string") return null;
  const projects = [...new Set(planned.map((connection) => connection.project))];
  let names: Record<string, Record<SecretGroup, string[]>>;
  try {
    // Names only, once per turn: eve saves what a memo returns.
    names = await ctx.memo(`kiln-connections:${ctx.turn?.id ?? "start"}`, async () =>
      Object.fromEntries(
        await Promise.all(
          projects.map(async (project) => [project, await secretNamesByGroup(boat, project)]),
        ),
      ),
    );
  } catch (error) {
    // Without boat the agent still works, without these connections this turn.
    log("connections.unavailable", { error: String(error) });
    return null;
  }
  const ready = planned.filter((connection) => {
    const have = names[connection.project];
    return have !== undefined && hasSecrets(connection, have);
  });
  if (ready.length === 0) return null;
  return Object.fromEntries(
    ready.map((connection) => [
      connection.name,
      defineMcpClientConnection({
        url: connection.url,
        description: connection.description,
        instanceKey: `${connection.project}/${connection.server}`,
        headers: async () => filledHeaders(connection, await environments()),
        approval: connection.approval === "always" ? always() : never(),
        ...(connection.tools ? { tools: connection.tools } : {}),
      }),
    ]),
  );
});
