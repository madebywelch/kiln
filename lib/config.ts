// What kiln's agent may work on, and with what by default. Both the agent and the
// workers read this file, so a repo missing here can be neither dispatched nor
// worked. Changing it means a redeploy of the agent and an update of workers.

/**
 * The agent kiln runs: the name it goes by in Slack, answers to without an @mention, and signs its
 * commits and pull requests with. Its persona is agent/instructions.md; its Slack app has the same name.
 */
export const agent = { name: "robdog" } as const;

/** claude and codex run on subscriptions; opencode runs AI Gateway models on the team's credits. */
export const HARNESSES = ["claude", "codex", "opencode"] as const;
export type Harness = (typeof HARNESSES)[number];

// The union of effort levels the harnesses accept. Codex and OpenCode have no
// `max`; their adapters send `xhigh` instead (see worker/harness.ts).
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** change: commit and open a draft PR. investigate: report findings, change nothing. */
export const KINDS = ["change", "investigate"] as const;
export type JobKind = (typeof KINDS)[number];

export interface Selection {
  readonly harness: Harness;
  /**
   * The harness's model name. Claude and Codex take their CLI's names or aliases (opus, gpt-5.5);
   * OpenCode takes an AI Gateway model ID (openai/gpt-6-luna-fast). Undefined: the CLI's default.
   */
  readonly model: string | undefined;
  readonly effort: Effort;
}

/**
 * An MCP server a job's harness may use. Header, env, and arg values may name
 * worker environment variables as ${NAME}; the worker fills them in, so
 * secrets live in the worker's environment, not here.
 */
export type McpServer =
  | { readonly url: string; readonly headers?: Readonly<Record<string, string>> }
  | {
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Readonly<Record<string, string>>;
    };

export interface RepoConfig {
  /** `owner/name` on GitHub. */
  readonly github: string;
  /** What the repo is, in the words people use for it. The agent maps conversation to repos with this. */
  readonly description: string;
  /** Branch that job branches start from and pull requests target. Default `main`. */
  readonly baseBranch?: string;
  /** Overrides of the global defaults for jobs on this repo, by kind of job. */
  readonly defaults?: Partial<Record<JobKind, Partial<Selection>>>;
  /** Names from `mcpServers` that jobs on this repo get. */
  readonly mcp?: readonly string[];
}

/** MCP servers jobs can use, by name. A repo lists the ones it gets in its `mcp`. */
export const mcpServers: Readonly<Record<string, McpServer>> = {
  // linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer ${LINEAR_API_KEY}" } },
};

export const repos: Readonly<Record<string, RepoConfig>> = {
  "player.games-app": {
    github: "madebywelch/player.games-app",
    description: "Player Games, the player.games website and its creator hub.",
  },
};

/** The default when neither the request nor the repo says otherwise: a cheap model reads, a heavy one writes. */
export const defaultSelection: Readonly<Record<JobKind, Selection>> = {
  change: { harness: "claude", model: "opus", effort: "high" },
  investigate: { harness: "opencode", model: "openai/gpt-6-luna-fast", effort: "medium" },
};

/** The model a harness runs when only the harness is named. Undefined: the CLI's configured default. */
export const defaultModels: Readonly<Record<Harness, string | undefined>> = {
  claude: "opus",
  codex: undefined,
  opencode: "openai/gpt-6-luna-fast",
};

/**
 * How many jobs may run at once on each harness, each on its own boat machine. One per Claude
 * subscription keeps a subscription's usage limits predictable. Codex needs a long-lived machine
 * for its login, so per-job machines can't run it.
 */
export const machineLimits: Readonly<Record<Harness, number>> = { claude: 1, codex: 0, opencode: 3 };

/** boat machine size for jobs. A Next.js dev build of a large app needs more than small's 4 GB. */
export const machineType = "default" as const;
