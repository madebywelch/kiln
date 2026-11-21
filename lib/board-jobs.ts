// Board operations on jobs, shared by the agent's tools and its report sweep.
// Every function takes the board handle, so tests run them on a local board.

import type { Board, MessageView } from "@vercel/board";
import {
  decodeJob,
  describeSelection,
  encodeJob,
  JOBS_CHANNEL,
  JobError,
  type JobSpec,
  REPORT_LABEL,
  REPORT_PENDING,
  type SlackOrigin,
} from "./jobs.ts";

export interface JobView {
  readonly id: string;
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
  /** The subscription it runs on, for a Claude job. */
  readonly subscription: string | null;
  /** When it starts again, if it is waiting for a subscription's usage to reset. */
  readonly waitingUntil: string | null;
}

export function viewJob(root: MessageView): JobView {
  const spec = decodeJob(root);
  const task = root.task;
  return {
    id: root.id,
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
    subscription: root.labels.account ?? null,
    waitingUntil: root.labels.waiting ? new Date(Number(root.labels.waiting) * 1000).toISOString() : null,
  };
}

/** Posts a job to the board and returns it, with the board's own message for whoever launches its machine. */
export async function postJob(
  team: Board,
  spec: JobSpec,
): Promise<JobView & { readonly message: MessageView }> {
  const { text, labels } = encodeJob(spec);
  const { task } = await team.tasks.create(JOBS_CHANNEL, { text, labels });
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

/** Posts one file the worker attached into the job's Slack thread. */
export type ShareFile = (
  origin: SlackOrigin,
  file: { readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> },
) => Promise<unknown>;

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
  share?: ShareFile,
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
      if (job.origin) {
        const { replies } = await team.thread(id, { limit: 100 });
        const last = replies.at(-1);
        // Files first, so the agent's reply comes after them. A retry of a failed hand-off posts them again.
        const shared: string[] = [];
        for (const attachment of share ? (last?.attachments ?? []) : []) {
          const response = await team.download(attachment.id);
          await share?.(job.origin, {
            name: attachment.name,
            bytes: new Uint8Array(await response.arrayBuffer()),
          });
          shared.push(attachment.name);
        }
        await deliver(
          job.origin,
          reportMessage(job, last?.text ?? "", shared),
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
    `Job #${job.id} "${job.title}" on ${job.repo} (${job.runsOn}, ${job.kind}) is ${job.state}.`,
  ];
  if (job.state === "blocked") {
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
      `The worker's files are already posted in this thread: ${files.join(", ")}. Refer to them; don't post them again.`,
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
 * Tells the agent a job is waiting because every subscription that can run its model is out of usage.
 * The model is the person's choice, so the agent offers to wait or restart and never picks one itself.
 */
export function waitingMessage(job: JobView, until: number): string {
  const when = new Date(until * 1000).toISOString();
  return [
    "[job update from the worker pool, not from a person]",
    `Job #${job.id} "${job.title}" on ${job.repo} (${job.runsOn}) is waiting: every subscription that can run it is out of usage.`,
    `The earliest one resets at ${when}; the job starts again on its own then, on the same model.`,
    "Tell this thread in a sentence, with the reset time in their words. Offer the choice: wait, or cancel it and start it again on a model they name. Never choose another model yourself.",
  ].join("\n");
}
