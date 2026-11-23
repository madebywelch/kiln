// The job contract between the agent (who posts jobs) and workers (who claim
// them). A job is a Vercel Board task in JOBS_CHANNEL: its root text is the
// brief, and its labels carry everything a worker routes and runs on.

import {
  defaultModels,
  defaultSelection,
  EFFORTS,
  type Effort,
  enabledHarnesses,
  HARNESSES,
  type Harness,
  type JobKind,
  KINDS,
  type Selection,
} from "./config.ts";
import type { RepoConfig } from "./deployment.ts";

export { type JobKind, KINDS };

export const JOBS_CHANNEL = "jobs";

/** Set by a worker when it settles a job; cleared by the agent once the result reached Slack. */
export const REPORT_LABEL = "report";
export const REPORT_PENDING = "pending";
/** Label on a job paused until its repo has these secrets: their names, comma-separated. */
export const NEEDS_SECRETS_LABEL = "needs_secrets";
/** The block kind of a job paused for secrets; a job paused for an answer is `needs_input`. */
export const NEEDS_SECRET_KIND = "needs_secret";

/**
 * The job's machine holds work to continue from: its clone, uncommitted changes and all. The value is
 * the coding CLI's session to continue, or `disk` when the CLI keeps none. The worker sets it when a
 * job pauses, or fails after real work; the agent then stops the machine instead of deleting it, and
 * resumes it when the job is ready again.
 */
export const RESUME_LABEL = "resume";
export const RESUME_DISK = "disk";
/** The job's branch, chosen on its first run, so every later run pushes to the same one. */
export const BRANCH_LABEL = "branch";
/** A job blocked with this kind waits for the inference endpoint, not for a person. */
export const INFERENCE_KIND = "inference";
/** When the agent next checks whether the endpoint is back, as an ISO time. */
export const WAIT_UNTIL_LABEL = "wait-until";
/** When the job first waited for inference, as an ISO time; it gives up after a day. */
export const WAIT_SINCE_LABEL = "wait-since";
/** The model the endpoint refused, to check again on. */
export const WAIT_MODEL_LABEL = "wait-model";
/** The Slack message, `channel:ts`, that told the job's asker inference is rate limited. */
export const NOTICE_LABEL = "notice";
/** Until when a failed job's stopped machine is kept for retry_job, as an ISO time. */
export const KEPT_UNTIL_LABEL = "kept-until";
/** When the agent last resumed the job's machine, as an ISO time. */
export const RESUMED_AT_LABEL = "resumed-at";

export const MAX_BRIEF_CHARS = 9_000;
export const MAX_TITLE_CHARS = 120;
/**
 * Files travel with a job both ways through Board attachments: the agent's in, the worker's
 * artifacts out. The same limits each way, sized to what Slack hands the agent (eve's 25 MB).
 */
export const MAX_JOB_FILES = 10;
/**
 * How much of a worker's report reaches the agent in its job update. A longer report is attached
 * whole as FULL_REPORT_FILE, which lands in the agent's drive with the job's other files.
 */
export const REPORT_INLINE_CHARS = 6_000;
export const FULL_REPORT_FILE = "full-report.md";
export const MAX_JOB_FILE_BYTES = 25 * 1024 * 1024;

export interface SlackOrigin {
  readonly channelId: string;
  readonly threadTs: string;
  /** Who asked, so the job's report reaches the thread as them; see Asker. */
  readonly asker?: Asker;
}

/**
 * The identity of the person behind the turn that started a job (or, when that turn runs as the app, the
 * person who started its session): no credentials, and of Slack's attributes only the
 * user ID. The job's report runs as them, because eve lets only a person, not the app, set a schedule,
 * and a report is where the agent most often needs one ("merge it once CI is green").
 */
export interface Asker {
  readonly authenticator: string;
  readonly principalType: string;
  readonly principalId: string;
  readonly issuer?: string;
  readonly subject?: string;
  readonly userId?: string;
}

/** The asker behind a turn's auth, or undefined when the turn runs as the app or as no one. */
export function askerOf(
  auth:
    | {
        readonly authenticator: string;
        readonly principalType: string;
        readonly principalId: string;
        readonly issuer?: string;
        readonly subject?: string;
        readonly attributes?: Readonly<Record<string, unknown>>;
      }
    | null
    | undefined,
): Asker | undefined {
  if (!auth || auth.principalType === "runtime" || auth.principalType === "anonymous") return undefined;
  const userId = auth.attributes?.user_id;
  return {
    authenticator: auth.authenticator,
    principalType: auth.principalType,
    principalId: auth.principalId,
    ...(auth.issuer ? { issuer: auth.issuer } : {}),
    ...(auth.subject ? { subject: auth.subject } : {}),
    ...(typeof userId === "string" && userId ? { userId } : {}),
  };
}

/**
 * The asker for a job started in a session: the person behind the current turn, or, when it runs as the app
 * (a job update, a scheduled turn), the person who started the session. Without the fallback, a job started
 * from a report on a job with no person would have none either, and so would every job after it.
 */
export function askerOfSession(auth: {
  readonly current: Parameters<typeof askerOf>[0];
  readonly initiator: Parameters<typeof askerOf>[0];
}): Asker | undefined {
  return askerOf(auth.current) ?? askerOf(auth.initiator);
}

/** The auth a report runs as: the asker's identity, with their Slack user ID as its one attribute. */
export function askerAuth(
  asker: Asker,
): Omit<Asker, "userId"> & { readonly attributes: Record<string, string> } {
  const { userId, ...identity } = asker;
  const attributes: Record<string, string> = userId ? { user_id: userId } : {};
  return { ...identity, attributes };
}

function decodeAsker(value: string | undefined): Asker | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as Partial<Asker>;
    if (typeof parsed.authenticator !== "string" || typeof parsed.principalType !== "string")
      return undefined;
    if (typeof parsed.principalId !== "string") return undefined;
    return parsed as Asker;
  } catch {
    return undefined; // a bad asker costs the report its person, not the report
  }
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
 * other harness serves.
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
 * then the repo's or project's defaults, then the global defaults. A model always belongs to
 * the harness that runs it, so a named model picks its harness, and a named
 * harness without a model gets that harness's default model.
 */
export function resolveSelection(
  repoKey: string,
  kind: JobKind,
  request: SelectionRequest,
  registry: Readonly<Record<string, Pick<RepoConfig, "defaults">>>,
  enabled: readonly Harness[] = enabledHarnesses,
): Selection {
  const repo = registry[repoKey];
  if (!repo) {
    const known = Object.keys(registry);
    throw new JobError(
      `unknown repo or project "${repoKey}"; ${known.length ? `known: ${known.join(", ")}` : "kiln.config.yaml names no repos"}`,
    );
  }
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
  if (!enabled.includes(selection.harness)) {
    throw new JobError(
      `${selection.harness}${selection.model ? ` (${selection.model})` : ""} is off: workers run ${enabled.join(", ")} only; enabledHarnesses in lib/config.ts`,
    );
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
    kiln: "job",
    repo: labelValue("repo", spec.repo),
    kind: spec.kind,
    harness: spec.harness,
    effort: spec.effort,
    title: labelValue("title", title),
  };
  if (spec.model !== undefined) labels.model = labelValue("model", spec.model);
  if (spec.origin)
    labels.slack = labelValue("slack origin", `${spec.origin.channelId}/${spec.origin.threadTs}`);
  if (spec.origin?.asker) labels.asker = labelValue("asker", JSON.stringify(spec.origin.asker));
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
  if (labels.kiln !== "job") throw new JobError("not a kiln job (label kiln=job missing)");
  const repo = labels.repo;
  const title = labels.title;
  if (!repo) throw new JobError("label repo is missing");
  if (!title) throw new JobError("label title is missing");

  let origin: SlackOrigin | undefined;
  if (labels.slack) {
    const [channelId, threadTs, ...rest] = labels.slack.split("/");
    if (!channelId || !threadTs || rest.length > 0)
      throw new JobError(`label slack=${labels.slack} is malformed`);
    const asker = decodeAsker(labels.asker);
    origin = { channelId, threadTs, ...(asker ? { asker } : {}) };
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

/** A job's short reference for people and the model, as in #b799fe5c: the first block of its board ID. */
export function jobRef(id: string): string {
  return /^msg_([0-9a-f]{8})-/.exec(id)?.[1] ?? id;
}

/** The longest description a branch name gets, cut at a word. */
const BRANCH_WORDS_MAX = 40;

/**
 * A job's branch: its owner, then a few words of its title, as in `octocat/add-a-christmas-theme`.
 * The owner is whoever pushes it. Not unique on its own: the worker adds the job's reference when the
 * name is taken (`jobBranchTaken`).
 */
export function jobBranch(owner: string, title: string): string {
  const words = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > BRANCH_WORDS_MAX) break;
    slug = next;
  }
  // A first word longer than the limit is cut rather than dropped.
  slug ||= (words[0] ?? "").slice(0, BRANCH_WORDS_MAX);
  return `${owner}/${slug || "job"}`;
}

/** The branch for a job whose name (`jobBranch`) is already someone else's branch. */
export function jobBranchTaken(name: string, taskId: string): string {
  return `${name}-${jobRef(taskId)}`;
}
