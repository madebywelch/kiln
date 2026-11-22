// Board operations on jobs, shared by the agent's tools and its report sweep.
// Every function takes the board handle, so tests run them on a local board.

import type { Board, MessageView } from "@vercel/board";
import type { JobFile } from "./job-files.ts";
import {
  decodeJob,
  describeSelection,
  encodeJob,
  JOBS_CHANNEL,
  JobError,
  type JobSpec,
  jobRef,
  NEEDS_SECRETS_LABEL,
  REPORT_LABEL,
  REPORT_PENDING,
  type SlackOrigin,
} from "./jobs.ts";

export interface JobView {
  /** The board's ID, for board operations. Show people `ref`. */
  readonly id: string;
  /** The short reference people and the model use: #b799fe5c. */
  readonly ref: string;
  readonly state: string;
  readonly title: string;
  readonly repo: string;
  readonly kind: string;
  readonly runsOn: string;
  readonly heldBy: string | null;
  readonly result: string | null;
  readonly reason: string | null;
  readonly question: string | null;
  readonly createdAt: string;
  readonly origin: SlackOrigin | undefined;
  /** The repo secrets it is paused for, if it is paused for secrets. */
  readonly secretsNeeded: readonly string[] | null;
}

export function viewJob(root: MessageView): JobView {
  const spec = decodeJob(root);
  const task = root.task;
  return {
    id: root.id,
    ref: jobRef(root.id),
    state: task?.state ?? "unknown",
    title: spec.title,
    repo: spec.repo,
    kind: spec.kind,
    runsOn: describeSelection(spec),
    heldBy: task?.claim?.actor ?? null,
    result: task?.result ?? null,
    reason: task?.reason ?? null,
    question: task?.blocked?.reason ?? null,
    createdAt: root.createdAt,
    origin: spec.origin,
    secretsNeeded: root.labels[NEEDS_SECRETS_LABEL]?.split(",").filter(Boolean) ?? null,
  };
}

/**
 * Posts a job to the board and returns it, with the board's own message for whoever launches its
 * machine. Its files are uploaded first and attached to the task, where the worker finds them.
 */
export async function postJob(
  team: Board,
  spec: JobSpec,
  files: readonly JobFile[] = [],
): Promise<JobView & { readonly message: MessageView }> {
  const { text, labels } = encodeJob(spec);
  const attachments = [];
  for (const file of files) attachments.push(await team.upload({ data: file.bytes, name: file.name }));
  const { task } = await team.tasks.create(JOBS_CHANNEL, {
    text,
    labels,
    ...(attachments.length ? { attachments } : {}),
  });
  return { ...viewJob(task), message: task };
}

export type JobStateFilter = NonNullable<NonNullable<Parameters<Board["tasks"]["list"]>[0]>["state"]>;

export async function listJobs(
  team: Board,
  query: { readonly state?: JobStateFilter; readonly limit?: number } = {},
): Promise<JobView[]> {
  const { tasks } = await team.tasks.list({
    channel: JOBS_CHANNEL,
    state: query.state ?? "open",
    label: { kiln: "job" },
    limit: query.limit ?? 20,
    latest: true,
  });
  return tasks.flatMap(({ message }) => {
    try {
      return [viewJob(message)];
    } catch {
      return []; // a task someone else posted in the channel; not ours to show
    }
  });
}

export interface JobLogEntry {
  readonly by: string;
  readonly at: string;
  readonly text: string;
}

/**
 * The board ID for a job someone named: its short reference (b799fe5c or #b799fe5c), or its full ID.
 * Models mangle long IDs when they copy them; an eight-character reference survives.
 */
export async function resolveJobId(team: Board, named: string): Promise<string> {
  const ref = named.trim().replace(/^#/, "");
  if (ref.startsWith("msg_")) return ref;
  const { tasks } = await team.tasks.list({
    channel: JOBS_CHANNEL,
    state: "all",
    label: { kiln: "job" },
    limit: 200,
  });
  const matches = tasks.map(({ message }) => message.id).filter((id) => jobRef(id) === ref.toLowerCase());
  if (matches.length === 0) throw new JobError(`no job #${ref}; list_jobs shows the recent ones`);
  if (matches.length > 1) throw new JobError(`#${ref} matches ${matches.length} jobs; name it in full`);
  return matches[0] as string;
}

export async function readJob(team: Board, id: string): Promise<{ job: JobView; log: JobLogEntry[] }> {
  const thread = await team.thread(id, { limit: 100 });
  const job = viewJob(thread.message);
  const log = thread.replies.map((reply) => ({
    by: reply.author?.name ?? reply.author?.handle ?? "unknown",
    at: reply.createdAt,
    text: reply.text,
  }));
  return { job, log };
}

export async function cancelJob(team: Board, id: string, reason: string): Promise<JobView> {
  await team.tasks.cancel(id, reason);
  // The agent canceled it, so there is nothing to report back.
  await team.label(id, { unset: [REPORT_LABEL] });
  const { message } = await team.thread(id, { limit: 1 });
  return viewJob(message);
}

/** Passes a person's answer to a blocked job and returns it to the queue. */
export async function answerJob(team: Board, id: string, answer: string): Promise<JobView> {
  const { message } = await team.thread(id, { limit: 1 });
  const job = viewJob(message);
  if (job.state !== "blocked") throw new JobError(`job #${id} is ${job.state}, not waiting for an answer`);
  await team.reply(id, `Answer from Slack:\n\n${answer}`);
  await team.label(id, { unset: [REPORT_LABEL] });
  await team.tasks.unblock(id);
  return { ...job, state: "ready", question: null };
}

const SETTLED_STATES = new Set(["completed", "failed", "blocked"]);
const MAX_REPORT_CHARS = 6_000;

export type DeliverReport = (
  origin: SlackOrigin,
  message: string,
  idempotencyKey: string,
) => Promise<unknown>;

/**
 * Handles one file the worker attached to a settled job: the agent saves it in its drive under
 * jobFilesFolder(job.id) and, when the job came from Slack, posts it in the thread.
 */
export type KeepFile = (job: JobView, file: JobFile) => Promise<unknown>;

/** Where a job's returned files are saved in the agent's drive. */
export const jobFilesFolder = (id: string) => `jobs/${jobRef(id)}/`;

export interface SweepResult {
  readonly delivered: string[];
  readonly skipped: string[];
  readonly failed: { readonly id: string; readonly error: string }[];
}

/**
 * Hands each job a worker settled to the Slack thread it came from, once.
 * Board is the outbox: a worker labels a settled job `report=pending`, and the
 * label is cleared only after the hand-off is accepted. A crash between the two
 * repeats the hand-off with the same idempotency key, which the session drops.
 */
export async function sweepReports(
  team: Board,
  deliver: DeliverReport,
  keep?: KeepFile,
): Promise<SweepResult> {
  const { tasks } = await team.tasks.list({
    channel: JOBS_CHANNEL,
    state: "all",
    label: { [REPORT_LABEL]: REPORT_PENDING },
    limit: 50,
  });
  const result: SweepResult = { delivered: [], skipped: [], failed: [] };

  for (const { message } of tasks) {
    const id = message.id;
    try {
      let job: JobView;
      try {
        job = viewJob(message);
      } catch {
        // Not a job this agent can read, such as one from before a rename: nothing to report, so drop the label.
        await team.label(id, { unset: [REPORT_LABEL] });
        result.skipped.push(id);
        continue;
      }
      if (job.state === "canceled") {
        // Canceled while the worker was settling it. The agent canceled it, so there is nothing to tell.
        await team.label(id, { unset: [REPORT_LABEL] });
        result.skipped.push(id);
        continue;
      }
      if (!SETTLED_STATES.has(job.state)) {
        result.skipped.push(id); // re-queued after the label was set; the next settle sets it again
        continue;
      }
      const { replies } = await team.thread(id, { limit: 100 });
      const last = replies.at(-1);
      // Files first, so the agent's reply comes after them, and kept even for a job with no thread.
      // A retry of a failed hand-off keeps them again: the same drive paths, posted again in Slack.
      const kept: string[] = [];
      for (const attachment of keep ? (last?.attachments ?? []) : []) {
        const response = await team.download(attachment.id);
        await keep?.(job, { name: attachment.name, bytes: new Uint8Array(await response.arrayBuffer()) });
        kept.push(attachment.name);
      }
      if (job.origin) {
        await deliver(
          job.origin,
          reportMessage(job, last?.text ?? "", kept),
          `job:${id}:${job.state}:${message.task?.epoch ?? 0}`,
        );
      }
      await team.label(id, { unset: [REPORT_LABEL], if: { [REPORT_LABEL]: REPORT_PENDING } });
      result.delivered.push(id);
    } catch (error) {
      result.failed.push({ id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export function reportMessage(job: JobView, lastReport: string, files: readonly string[] = []): string {
  const lines = [
    "[job update from the worker pool, not from a person]",
    `Job #${job.ref} "${job.title}" on ${job.repo} (${job.runsOn}, ${job.kind}) is ${job.state}.`,
  ];
  if (job.state === "blocked" && job.secretsNeeded?.length) {
    lines.push(`It is paused until ${job.repo} has these secrets: ${job.secretsNeeded.join(", ")}.`);
    if (job.question) lines.push(`The worker says: ${job.question}`);
    lines.push(
      `Call request_secret for each one with job "#${job.ref}". Saving the last one resumes the job on its own; nobody needs to say retry. Never ask for a value in the thread.`,
    );
  } else if (job.state === "blocked") {
    lines.push(`The worker asks: ${job.question ?? "(no question given)"}`);
    lines.push(
      "Relay the question here. When someone answers, pass the answer on with answer_job; the job then resumes.",
    );
  } else {
    if (job.result) lines.push(`Result: ${job.result}`);
    if (job.reason) lines.push(`Reason: ${job.reason}`);
    lines.push(
      "Tell this thread what came of it in a sentence or two, with the pull request link if there is one.",
    );
  }
  if (files.length > 0) {
    lines.push(
      `The worker's files are already posted in this thread and saved in your drive under ${jobFilesFolder(job.id)}: ${files.join(", ")}. Refer to them; don't post them again.`,
    );
  }
  const report = lastReport.trim();
  if (report) {
    const clipped =
      report.length > MAX_REPORT_CHARS ? `${report.slice(0, MAX_REPORT_CHARS)}\n[report clipped]` : report;
    lines.push("", "Worker's last message:", clipped);
  }
  return lines.join("\n");
}

/**
 * After someone saves a repo secret for a paused job: resumes the job if the repo now has every secret
 * it waits for. Returns what to tell the thread, or undefined when the job isn't paused for secrets.
 */
export async function resumeAfterSecrets(
  team: Board,
  id: string,
  repoSecrets: readonly string[],
): Promise<{ readonly resumed: boolean; readonly missing: readonly string[] } | undefined> {
  const { message } = await team.thread(id, { limit: 1 });
  const job = viewJob(message);
  if (job.state !== "blocked" || !job.secretsNeeded?.length) return undefined;
  const missing = job.secretsNeeded.filter((name) => !repoSecrets.includes(name));
  if (missing.length > 0) return { resumed: false, missing };
  await team.label(id, { unset: [NEEDS_SECRETS_LABEL, REPORT_LABEL] });
  await team.tasks.unblock(id);
  return { resumed: true, missing: [] };
}
