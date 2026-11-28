// How each coding CLI is invoked headless, how it gets the job's MCP servers,
// and how its final message is read.

import { readFile } from "node:fs/promises";
import type { Effort, Harness, Selection } from "../lib/config.ts";
import type { McpServer } from "../lib/deployment.ts";
import { type Inference, inferenceHost } from "../lib/inference.ts";

export interface HarnessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  /** The prompt, on stdin. Undefined: it is in `args`. */
  readonly stdin: string | undefined;
  /** Variables added to the CLI's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Reads the harness's final message once it has exited 0. */
  readonly readReport: (stdout: string) => Promise<string>;
  /** The session the run worked in, which a later run can continue; undefined for a CLI kiln can't resume. */
  readonly sessionOf: (stdout: string) => string | undefined;
}

export type HarnessBins = Readonly<Record<Harness, string>>;

export const defaultBins: HarnessBins = { claude: "claude", codex: "codex", opencode: "opencode" };

/** OpenCode reaches AI Gateway models through its `vercel` provider. */
export const GATEWAY_PROVIDER = "vercel";

/**
 * Codex's settings for the deployment's inference endpoint: its OpenAI Responses API at the host's /v1,
 * with the key read from INFERENCE_API_KEY. No ChatGPT login: the machine's own Codex config adds only
 * MCP servers, and these settings override any provider it names.
 */
export function codexEndpointArgs(endpoint: Inference): string[] {
  const provider = "model_providers.kiln";
  return [
    ["model_provider", "kiln"],
    [`${provider}.name`, "kiln inference endpoint"],
    [`${provider}.base_url`, `${inferenceHost(endpoint.baseURL)}/v1`],
    [`${provider}.env_key`, "INFERENCE_API_KEY"],
    [`${provider}.wire_api`, "responses"],
  ].flatMap(([key, value]) => ["-c", `${key}=${toml(value)}`]);
}

/** Codex's and OpenCode's reasoning efforts stop at xhigh. */
export function topEffort(effort: Effort): string {
  return effort === "max" ? "xhigh" : effort;
}

/** An MCP server with its ${VAR} references filled in from the worker's environment. */
export type ResolvedMcp = McpServer;

/** The repo's secrets a job needs and doesn't have. The job waits for them instead of failing. */
export class MissingSecrets extends Error {
  override readonly name = "MissingSecrets";
  readonly names: readonly string[];
  constructor(names: readonly string[]) {
    super(`this repo's secrets don't have ${names.join(", ")}, which its MCP servers need`);
    this.names = names;
  }
}

/** Fills ${NAME} references from `env`. Throws MissingSecrets naming every variable that is missing. */
export function resolveMcp(
  servers: Readonly<Record<string, McpServer>>,
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Record<string, ResolvedMcp> {
  const missing = new Set<string>();
  const fill = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const found = env[name];
      if (found === undefined || found === "") missing.add(name);
      return found ?? "";
    });
  const fillAll = (record: Readonly<Record<string, string>> | undefined) =>
    record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(value)])) : undefined;

  const resolved: Record<string, ResolvedMcp> = {};
  for (const name of names) {
    const server = servers[name];
    if (!server) throw new Error(`MCP server "${name}" is not defined in lib/config.ts`);
    if ("url" in server) {
      const headers = fillAll(server.headers);
      resolved[name] = { url: fill(server.url), ...(headers ? { headers } : {}) };
    } else {
      const env = fillAll(server.env);
      resolved[name] = {
        command: server.command,
        args: (server.args ?? []).map(fill),
        ...(env ? { env } : {}),
      };
    }
  }
  if (missing.size > 0) throw new MissingSecrets([...missing].sort());
  return resolved;
}

const toml = (value: unknown) => JSON.stringify(value); // a JSON string or array is a valid TOML value
const tomlTable = (record: Readonly<Record<string, string>>) =>
  `{ ${Object.entries(record)
    .map(([key, value]) => `${toml(key)} = ${toml(value)}`)
    .join(", ")} }`;

/** Claude Code settings for every job: `attribution` for current versions, `includeCoAuthoredBy` for older ones. */
export const CLAUDE_SETTINGS = { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false } as const;

export function harnessInvocation(
  selection: Selection,
  prompt: string,
  cwd: string,
  reportFile: string,
  mcp: Readonly<Record<string, ResolvedMcp>> = {},
  bins: HarnessBins = defaultBins,
  /** A session to continue, from an earlier run on this machine: Claude Code only. */
  resume?: string,
  /** The deployment's inference endpoint, which Codex runs on. Claude Code gets it through its environment. */
  endpoint?: Inference,
): HarnessInvocation {
  const servers = Object.entries(mcp);
  switch (selection.harness) {
    case "claude": {
      // The machine is the sandbox: there is no person to answer a permission prompt. stream-json puts
      // each event in the log as it happens, so a failed run's log shows how far it got.
      const args = [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        "bypassPermissions",
      ];
      // Commits and PRs are the token owner's work: no Co-Authored-By trailer, no "Generated with" line.
      args.push("--settings", JSON.stringify(CLAUDE_SETTINGS));
      args.push("--effort", selection.effort);
      if (selection.model) args.push("--model", selection.model);
      if (resume) args.push("--resume", resume);
      if (servers.length > 0) {
        const config = Object.fromEntries(
          servers.map(([name, server]) => [
            name,
            "url" in server
              ? { type: "http", url: server.url, headers: server.headers ?? {} }
              : { type: "stdio", command: server.command, args: server.args ?? [], env: server.env ?? {} },
          ]),
        );
        args.push("--mcp-config", JSON.stringify({ mcpServers: config }));
      }
      return {
        command: bins.claude,
        args,
        stdin: prompt,
        env: {},
        readReport: async (out) => claudeReport(out),
        sessionOf: claudeSession,
      };
    }
    case "codex": {
      if (!endpoint)
        throw new Error("codex runs on the deployment's inference endpoint, which this worker lacks");
      const args = ["exec", "--dangerously-bypass-approvals-and-sandbox", "-C", cwd, "-o", reportFile];
      args.push(...codexEndpointArgs(endpoint));
      args.push("-c", `model_reasoning_effort="${topEffort(selection.effort)}"`);
      if (selection.model) args.push("-m", selection.model);
      for (const [name, server] of servers) {
        const key = `mcp_servers.${name}`;
        if ("url" in server) {
          args.push("-c", `${key}.url=${toml(server.url)}`);
          if (server.headers) args.push("-c", `${key}.http_headers=${tomlTable(server.headers)}`);
        } else {
          args.push(
            "-c",
            `${key}.command=${toml(server.command)}`,
            "-c",
            `${key}.args=${toml(server.args ?? [])}`,
          );
          if (server.env) args.push("-c", `${key}.env=${tomlTable(server.env)}`);
        }
      }
      args.push("-");
      return {
        command: bins.codex,
        args,
        stdin: prompt,
        env: { INFERENCE_API_KEY: endpoint.apiKey },
        readReport: async () => (await readFile(reportFile, "utf8")).trim(),
        sessionOf: () => undefined,
      };
    }
    case "opencode": {
      const args = ["run", "--format", "json", "--auto", "--dir", cwd];
      if (selection.model) args.push("-m", `${GATEWAY_PROVIDER}/${selection.model}`);
      args.push("--variant", topEffort(selection.effort));
      const env: Record<string, string> = {};
      if (servers.length > 0) {
        const config = Object.fromEntries(
          servers.map(([name, server]) => [
            name,
            "url" in server
              ? { type: "remote", url: server.url, headers: server.headers ?? {}, enabled: true }
              : {
                  type: "local",
                  command: [server.command, ...(server.args ?? [])],
                  environment: server.env ?? {},
                  enabled: true,
                },
          ]),
        );
        env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ mcp: config });
      }
      args.push(prompt);
      return {
        command: bins.opencode,
        args,
        stdin: undefined,
        env,
        readReport: async (out) => opencodeReport(out),
        sessionOf: () => undefined,
      };
    }
  }
}

/** `claude -p --output-format stream-json` prints one event per line; the last `result` holds the final message. */
export function claudeReport(stdout: string): string {
  const results: { result?: unknown; is_error?: unknown }[] = [];
  for (const line of stdout.split("\n")) {
    const event = parseLine(line);
    if (event?.type === "result" || (event && "is_error" in event)) results.push(event);
  }
  const last = results.at(-1);
  if (!last) throw new Error(`claude printed no JSON result: ${stdout.trim().slice(-200)}`);
  if (last.is_error === true)
    throw new Error(`claude reported an error: ${String(last.result).slice(0, 500)}`);
  // One result per turn. A background command that finishes after the final message starts another
  // turn, whose short reply ("the report above stands") must not replace the report: keep them all.
  const texts = results
    .filter((event) => event.is_error !== true && typeof event.result === "string")
    .map((event) => (event.result as string).trim())
    .filter(Boolean);
  if (texts.length === 0) throw new Error("claude's JSON result has no text");
  return texts.join("\n\n");
}

/** The session Claude Code worked in: every stream-json event names it, the first one before any model call. */
export function claudeSession(stdout: string): string | undefined {
  let session: string | undefined;
  for (const line of stdout.split("\n")) {
    const id = parseLine(line)?.session_id;
    if (typeof id === "string" && id) session = id;
  }
  return session;
}

/** `opencode run --format json` prints one event per line; the final message is the last message's text parts. */
export function opencodeReport(stdout: string): string {
  const texts = new Map<string, string[]>();
  let last: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let event: { type?: string; error?: unknown; part?: { messageID?: string; text?: string } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "error")
      throw new Error(`opencode reported an error: ${JSON.stringify(event.error ?? event).slice(0, 500)}`);
    if (event.type === "text" && event.part?.messageID && typeof event.part.text === "string") {
      const parts = texts.get(event.part.messageID) ?? [];
      parts.push(event.part.text);
      texts.set(event.part.messageID, parts);
      last = event.part.messageID;
    }
  }
  const report = last ? (texts.get(last) ?? []).join("").trim() : "";
  if (!report) throw new Error("opencode printed no final message");
  return report;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim().startsWith("{")) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
