// The job contract between robdog (who posts jobs) and workers (who claim
// them). A job is a Vercel Board task in JOBS_CHANNEL: its root text is the
// brief, and its labels carry everything a worker routes and runs on.

import {
  defaultModels,
  defaultSelection,
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type JobKind,
  KINDS,
  type RepoConfig,
  repos,
  type Selection,
} from "./config.ts";

export { type JobKind, KINDS };

export const JOBS_CHANNEL = "jobs";

/** Set by a worker when it settles a job; cleared by robdog once the result reached Slack. */
export const REPORT_LABEL = "report";
export const REPORT_PENDING = "pending";

export const MAX_BRIEF_CHARS = 9_000;
export const MAX_TITLE_CHARS = 120;

export interface SlackOrigin {
  readonly channelId: string;
  readonly threadTs: string;
}

export interface JobSpec extends Selection {
  readonly repo: string;
  readonly kind: JobKind;
  readonly title: string;
  readonly brief: string;
  readonly origin: SlackOrigin | undefined;
}

export class JobError extends Error {
  override readonly name = "JobError";
}

export interface SelectionRequest {
  readonly harness?: Harness | undefined;
  readonly model?: string | undefined;
  readonly effort?: Effort | undefined;
}

/**
 * Which harness serves a model name, or undefined when the name says nothing.
 * An AI Gateway ID (provider/model) runs on OpenCode, and so does a model no
 * subscription covers.
 */
export function inferHarness(model: string): Harness | undefined {
  const name = model.toLowerCase();
  if (name.includes("/")) return "opencode";
  if (/(claude|opus|sonnet|haiku|fable|mythos)/.test(name)) return "claude";
  if (/(deepseek|gemini|kimi|glm|qwen|grok|mistral|llama|luna)/.test(name)) return "opencode";
  if (/(gpt|codex|^o\d)/.test(name)) return "codex";
  return undefined;
}

function checkModel(harness: Harness, model: string | undefined): void {
  if (harness === "opencode" && model !== undefined && !model.includes("/")) {
    throw new JobError(
      `opencode needs an AI Gateway model ID such as openai/gpt-6-luna-fast, not "${model}"`,
    );
  }
}

/**
 * Resolves what a job runs on. Precedence, field by field: what was asked for,
 * then the repo's defaults, then the global defaults. A model always belongs to
 * the harness that runs it, so a named model picks its harness, and a named
 * harness without a model gets that harness's default model.
 */
export function resolveSelection(
  repoKey: string,
  kind: JobKind,
  request: SelectionRequest,
  registry: Readonly<Record<string, RepoConfig>> = repos,
): Selection {
  const repo = registry[repoKey];
  if (!repo) throw new JobError(`unknown repo "${repoKey}"; known: ${Object.keys(registry).join(", ")}`);
  const repoDefaults = repo.defaults?.[kind] ?? {};
  const global = defaultSelection[kind];
  const effort = request.effort ?? repoDefaults.effort ?? global.effort;
  // The model a harness gets by default here: the repo's, then the global one for this kind, then the harness's own.
  const defaultModelFor = (harness: Harness) =>
    repoDefaults.harness === harness && repoDefaults.model !== undefined
      ? repoDefaults.model
      : global.harness === harness
        ? global.model
        : defaultModels[harness];

  let selection: Selection;
  if (request.model) {
    const inferred = inferHarness(request.model);
    if (request.harness && inferred && request.harness !== inferred) {
      throw new JobError(`model "${request.model}" runs on ${inferred}, not ${request.harness}`);
    }
    const harness = request.harness ?? inferred;
    if (!harness) {
      throw new JobError(`can't tell which harness runs model "${request.model}"; name the harness too`);
    }
    selection = { harness, model: request.model, effort };
  } else {
    const harness = request.harness ?? repoDefaults.harness ?? global.harness;
    selection = {
      harness,
      model: request.harness ? defaultModelFor(harness) : (repoDefaults.model ?? defaultModelFor(harness)),
      effort,
    };
  }
  checkModel(selection.harness, selection.model);
  return selection;
}

const LABEL_VALUE_BYTES = 256;

function labelValue(name: string, value: string): string {
  // Vercel's board refuses control characters and values over 256 bytes.
  if (/[\p{Cc}]/u.test(value)) throw new JobError(`${name} must be one line`);
  if (Buffer.byteLength(value) > LABEL_VALUE_BYTES) throw new JobError(`${name} is too long for a label`);
  return value;
}

export interface EncodedJob {
  readonly text: string;
  readonly labels: Record<string, string>;
}

export function encodeJob(spec: JobSpec): EncodedJob {
  const title = spec.title.trim();
  const brief = spec.brief.trim();
  if (!title) throw new JobError("a job needs a title");
  if (title.length > MAX_TITLE_CHARS) throw new JobError(`title is over ${MAX_TITLE_CHARS} characters`);
  if (!brief) throw new JobError("a job needs a brief");
  if (brief.length > MAX_BRIEF_CHARS) throw new JobError(`brief is over ${MAX_BRIEF_CHARS} characters`);

  const labels: Record<string, string> = {
    robdog: "job",
    repo: labelValue("repo", spec.repo),
    kind: spec.kind,
    harness: spec.harness,
    effort: spec.effort,
    title: labelValue("title", title),
  };
  if (spec.model !== undefined) labels.model = labelValue("model", spec.model);
  if (spec.origin)
    labels.slack = labelValue("slack origin", `${spec.origin.channelId}/${spec.origin.threadTs}`);
  return { text: `## ${title}\n\n${brief}`, labels };
}

function oneOf<T extends string>(name: string, value: string | undefined, allowed: readonly T[]): T {
  if (value !== undefined && (allowed as readonly string[]).includes(value)) return value as T;
  throw new JobError(`label ${name}=${value ?? "(missing)"} is not one of ${allowed.join(", ")}`);
}

/** Reads a job back from a task's root. Throws JobError when the task is not a well-formed job. */
export function decodeJob(root: {
  readonly text: string;
  readonly labels: Readonly<Record<string, string>>;
}): JobSpec {
  const { labels } = root;
  if (labels.robdog !== "job") throw new JobError("not a robdog job (label robdog=job missing)");
  const repo = labels.repo;
  const title = labels.title;
  if (!repo) throw new JobError("label repo is missing");
  if (!title) throw new JobError("label title is missing");

  let origin: SlackOrigin | undefined;
  if (labels.slack) {
    const [channelId, threadTs, ...rest] = labels.slack.split("/");
    if (!channelId || !threadTs || rest.length > 0)
      throw new JobError(`label slack=${labels.slack} is malformed`);
    origin = { channelId, threadTs };
  }

  const heading = `## ${title}\n\n`;
  const brief = root.text.startsWith(heading) ? root.text.slice(heading.length) : root.text;

  return {
    repo,
    title,
    brief,
    origin,
    kind: oneOf("kind", labels.kind, KINDS),
    harness: oneOf("harness", labels.harness, HARNESSES),
    effort: oneOf("effort", labels.effort, EFFORTS),
    model: labels.model,
  };
}

/** `claude opus/high`, or `codex default/xhigh` when the CLI picks the model. */
export function describeSelection(selection: Selection): string {
  return `${selection.harness} ${selection.model ?? "default"}/${selection.effort}`;
}

/** A branch name that is unique per job and readable in a PR list. */
export function jobBranch(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug ? `robdog/${taskId}-${slug}` : `robdog/${taskId}`;
}
