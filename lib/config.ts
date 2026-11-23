// kiln's own settings, the same for everyone who runs it: the harnesses, the
// default models, and the limits. Which repos a deployment works on, and their
// MCP servers, are its own business: they live in kiln.config.yaml (see
// lib/deployment.ts), never here.

/** claude runs on the deployment's inference endpoint; codex needs a ChatGPT login; opencode runs AI Gateway models. */
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
 * The harnesses workers may run: Claude Code, on the deployment's inference endpoint (INFERENCE_*).
 * opencode runs AI Gateway models on WORKER_AI_GATEWAY_API_KEY, so it is off; add it here to allow that.
 * Codex joins once its login can be lent to per-job machines.
 */
export const enabledHarnesses: readonly Harness[] = ["claude"];

/** The default when neither the request nor the repo says otherwise: a fast model researches, a heavy one implements. */
export const defaultSelection: Readonly<Record<JobKind, Selection>> = {
  change: { harness: "claude", model: "opus", effort: "high" },
  investigate: { harness: "claude", model: "sonnet", effort: "high" },
};

/** The model a harness runs when only the harness is named. Undefined: the CLI's configured default. */
export const defaultModels: Readonly<Record<Harness, string | undefined>> = {
  claude: "opus",
  codex: undefined,
  opencode: "openai/gpt-6-luna-fast",
};

/** Jobs that may run at once on each harness, each on its own boat machine. */
export const machineLimits: Readonly<Partial<Record<Harness, number>>> = { opencode: 3, claude: 4 };

/** Days a failed job's stopped machine is kept, with its work, for retry_job to continue from. */
export const keptMachineDays = 3;

/** boat machine size for jobs. A Next.js dev build of a large app needs more than small's 4 GB. */
export const machineType = "default" as const;

/**
 * The agent's GitHub token: KILN_GH_TOKEN, or the workers' WORKER_GH_TOKEN when that is unset. Its
 * sandbox's firewall adds it to `gh`, and the agent's own function uses it to copy secrets into GitHub.
 */
export const agentGitHubToken = (env: NodeJS.ProcessEnv = process.env): string | undefined =>
  env.KILN_GH_TOKEN || env.WORKER_GH_TOKEN || undefined;
