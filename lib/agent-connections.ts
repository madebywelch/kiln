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
//
// A server marked `agent: { everywhere: true }` is one connection, named for
// the server, in every conversation: the agent's own tool, such as a memory
// service, rather than a project's. Its ${NAME}s come from the agent's own
// environment (AGENT_SECRET_PREFIX), and jobs never get it.

import { variableValue } from "./boat.ts";
import {
  AGENT_SECRET_PREFIX,
  type Deployment,
  isEverywhere,
  type McpServer,
  projectsOf,
  secretsNamedBy,
  type ToolFilter,
} from "./deployment.ts";
import { environmentName, groupOfSecret, type SecretGroup } from "./secrets.ts";

export interface PlannedConnection {
  /** `<server>-<project>`, or the server's for an everywhere one: eve's connection name, and its tools' prefix. */
  readonly name: string;
  /** null for an everywhere server, whose secrets are in the agent's own environment. */
  readonly project: string | null;
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

/**
 * eve's connection name for a server on a project, or an everywhere server alone: letters, digits, - and _,
 * starting with a letter.
 */
export function connectionName(server: string, project: string | null): string {
  const name = (project === null ? server : `${server}-${project}`)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return /^[a-z]/.test(name) ? name : `mcp-${name}`;
}

/** Every connection this deployment describes, whatever its name's length. */
function describedConnections(config: Deployment): PlannedConnection[] {
  const connection = (server: string, definition: McpServer, project: string | null, about?: string) => {
    if (!("url" in definition) || !definition.agent) return [];
    const secrets = secretsNamedBy({ [server]: { url: definition.url, headers: definition.headers } });
    // An everywhere server's names carry AGENT_SECRET_PREFIX before the group's prefix.
    const group = (secret: string) =>
      groupOfSecret(project === null ? secret.slice(AGENT_SECRET_PREFIX.length) : secret);
    const described = definition.description ?? server;
    return [
      {
        name: connectionName(server, project),
        project,
        server,
        url: definition.url,
        headers: definition.headers ?? {},
        description: project === null ? described : `${described} For ${project}: ${about}`,
        secrets,
        approval: secrets.some((secret) => group(secret) === "production-write") ? "always" : "never",
        ...(definition.agent === true || !definition.agent.tools ? {} : { tools: definition.agent.tools }),
      } satisfies PlannedConnection,
    ];
  };
  const described: PlannedConnection[] = [];
  for (const [server, definition] of Object.entries(config.mcpServers))
    if (isEverywhere(definition)) described.push(...connection(server, definition, null));
  for (const [project, { description: about, mcp }] of Object.entries(projectsOf(config)))
    for (const server of mcp) {
      const definition = config.mcpServers[server];
      if (definition && !isEverywhere(definition))
        described.push(...connection(server, definition, project, about));
    }
  return described;
}

/** Every connection the agent gets from this deployment, whether or not its secrets are set. */
export function plannedConnections(config: Deployment): PlannedConnection[] {
  // Names eve can't take are refused by `pnpm run deploy` (connectionNameIssues), so never live.
  return describedConnections(config).filter((connection) => connection.name.length <= MAX_NAME);
}

/** Connections whose names are too long for eve, or taken twice, for `pnpm run deploy` to refuse. */
export function connectionNameIssues(config: Deployment): string[] {
  const issues: string[] = [];
  const seen = new Set<string>();
  for (const { name, server, project } of describedConnections(config)) {
    const which = project === null ? server : `${server} on ${project}`;
    if (name.length > MAX_NAME)
      issues.push(`${which}: its connection name ${name} is over ${MAX_NAME} characters`);
    if (seen.has(name)) issues.push(`${which}: its connection name ${name} is taken by another connection`);
    seen.add(name);
  }
  return issues;
}

/**
 * The secrets an everywhere connection names that the agent's environment doesn't set (empty counts as
 * unset). It's offered only when there are none.
 */
export function unsetAgentSecrets(
  connection: PlannedConnection,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return connection.secrets.filter((secret) => !env[secret]);
}

/** An everywhere connection's headers, filled from the agent's environment. Throws naming an unset secret. */
export function agentHeaders(
  connection: PlannedConnection,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return fill(connection.headers, (secret) => {
    const found = env[secret];
    if (!found) throw new Error(`${secret} isn't set on the agent's Vercel project`);
    return found;
  });
}

function fill(
  headers: Readonly<Record<string, string>>,
  value: (secret: string) => string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([header, template]) => [
      header,
      template.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, secret: string) => value(secret)),
    ]),
  );
}

/** Whether every secret the connection names is set, given each group's names for its project. */
export function hasSecrets(
  connection: PlannedConnection,
  names: Readonly<Record<SecretGroup, readonly string[]>>,
): boolean {
  if (connection.project === null) return false;
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
  const { project } = connection;
  if (project === null) throw new Error(`${connection.name} is an everywhere connection; use agentHeaders`);
  return fill(connection.headers, (secret) => {
    const group = groupOfSecret(secret);
    const environment = environments.find((e) => e.name === environmentName(project, group));
    const found = environment ? variableValue(environment.envContents, secret) : undefined;
    if (!found) throw new Error(`${secret} isn't in ${project}'s ${group} secrets`);
    return found;
  });
}
