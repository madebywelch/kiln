// The agent's own MCP connections, so it can look things up itself (an error in
// Sentry, a metric in Grafana) instead of starting a job for every question.
//
// A hosted server in kiln.config.yaml marked `agent` becomes one connection per
// project that lists it, named `<server>-<project>`, because each project has
// its own secrets. The ${NAME}s in its headers are filled from the project's
// secrets in boat when a call is made, by the agent's function: the model never
// sees a value, and eve keeps only names. Each secret's name says its group
// (lib/secrets.ts), so a server whose secrets can change production
// (PROD_WRITE_) asks a person before every call. A connection whose secrets
// aren't all set yet isn't offered.

import { variableValue } from "./boat.ts";
import { type Deployment, projectsOf, secretsNamedBy, type ToolFilter } from "./deployment.ts";
import { environmentName, groupOfSecret, type SecretGroup } from "./secrets.ts";

export interface PlannedConnection {
  /** `<server>-<project>`: eve's connection name, and the prefix of its tools' names. */
  readonly name: string;
  readonly project: string;
  readonly server: string;
  readonly url: string;
  /** With their ${NAME}s, filled in only when a call is made. */
  readonly headers: Readonly<Record<string, string>>;
  readonly description: string;
  /** The secrets its headers name. */
  readonly secrets: readonly string[];
  /** Ask a person before every call: its secrets can change production. */
  readonly approval: "never" | "always";
  readonly tools?: ToolFilter;
}

const MAX_NAME = 64;

/** eve's connection name for a server on a project: letters, digits, - and _, starting with a letter. */
export function connectionName(server: string, project: string): string {
  const name = `${server}-${project}`.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  return /^[a-z]/.test(name) ? name : `mcp-${name}`;
}

/** Every connection the agent gets from this deployment, whether or not its secrets are set. */
export function plannedConnections(config: Deployment): PlannedConnection[] {
  const planned: PlannedConnection[] = [];
  for (const [project, { description: about, mcp }] of Object.entries(projectsOf(config))) {
    for (const server of mcp) {
      const definition = config.mcpServers[server];
      if (!definition || !("url" in definition) || !definition.agent) continue;
      const secrets = secretsNamedBy({ [server]: { url: definition.url, headers: definition.headers } });
      const name = connectionName(server, project);
      if (name.length > MAX_NAME) continue; // checked by `pnpm run deploy`, so never live
      planned.push({
        name,
        project,
        server,
        url: definition.url,
        headers: definition.headers ?? {},
        description: `${definition.description ?? server} For ${project}: ${about}`,
        secrets,
        approval: secrets.some((secret) => groupOfSecret(secret) === "production-write") ? "always" : "never",
        ...(definition.agent === true ? {} : { tools: definition.agent.tools }),
      });
    }
  }
  return planned;
}

/** Connections whose names are too long for eve, for `pnpm run deploy` to refuse. */
export function connectionNameIssues(config: Deployment): string[] {
  const issues: string[] = [];
  for (const [project, { mcp }] of Object.entries(projectsOf(config)))
    for (const server of mcp) {
      const definition = config.mcpServers[server];
      if (
        definition &&
        "url" in definition &&
        definition.agent &&
        connectionName(server, project).length > MAX_NAME
      )
        issues.push(
          `${server} on ${project}: its connection name ${connectionName(server, project)} is over ${MAX_NAME} characters`,
        );
    }
  return issues;
}

/** Whether every secret the connection names is set, given each group's names for its project. */
export function hasSecrets(
  connection: PlannedConnection,
  names: Readonly<Record<SecretGroup, readonly string[]>>,
): boolean {
  return connection.secrets.every((secret) => names[groupOfSecret(secret)].includes(secret));
}

/**
 * The connection's headers with their secrets filled in from boat's environments. Throws, naming the
 * secret and never a value, when one isn't set.
 */
export function filledHeaders(
  connection: PlannedConnection,
  environments: readonly { readonly name: string; readonly envContents: string }[],
): Record<string, string> {
  const value = (secret: string) => {
    const group = groupOfSecret(secret);
    const environment = environments.find((e) => e.name === environmentName(connection.project, group));
    const found = environment ? variableValue(environment.envContents, secret) : undefined;
    if (!found) throw new Error(`${secret} isn't in ${connection.project}'s ${group} secrets`);
    return found;
  };
  return Object.fromEntries(
    Object.entries(connection.headers).map(([header, template]) => [
      header,
      template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, secret: string) => value(secret)),
    ]),
  );
}
