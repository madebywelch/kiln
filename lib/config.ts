// kiln's own settings, the same for everyone who runs it: the harnesses, the
// default models, and the limits. Which repos a deployment works on, and their
// MCP servers, are its own business: they live in kiln.config.yaml (see
// lib/deployment.ts), never here.

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
 * Jobs that may run at once on one subscription. Each Claude subscription runs this many; a job that
 * exhausts its subscription moves to another one with the same model, never to another model.
 */
export const jobsPerSubscription = 2;

/** Jobs that may run at once on a harness billed per token, each on its own boat machine. */
export const machineLimits: Readonly<Partial<Record<Harness, number>>> = { opencode: 3 };

/** boat machine size for jobs. A Next.js dev build of a large app needs more than small's 4 GB. */
export const machineType = "default" as const;
