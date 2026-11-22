// What a scheduled task saves and what it sends when it fires. Kept apart from
// the schedule definition so tests can check it without eve's runtime.

import { slackHere } from "./slack.ts";

/** Where a task reports: the thread it was set in, or a new message in that channel each time. */
export const POST_WHERE = ["thread", "channel"] as const;

export interface TaskPayload {
  readonly task: string;
  readonly post: (typeof POST_WHERE)[number];
}

/** What the schedule saves: the task, and the Slack destination taken from the conversation that set it. */
export interface PreparedTask {
  readonly task: string;
  readonly channelId: string;
  readonly threadTs?: string;
}

export class ScheduleError extends Error {
  override readonly name = "ScheduleError";
}

/** Captures the destination from the conversation, so the model never names channels and a task can't be aimed elsewhere. */
export function prepareTask(input: TaskPayload, context: Parameters<typeof slackHere>[0]): PreparedTask {
  const here = slackHere(context);
  if (!here) throw new ScheduleError("schedules can only be set from a Slack conversation");
  const threadTs = input.post === "thread" ? here.threadTs : undefined;
  return { task: input.task, channelId: here.channelId, ...(threadTs ? { threadTs } : {}) };
}

/** The message a firing sends; the agent does the task in reply. */
export function firingMessage(task: string, name: string, scheduledAt: string): string {
  return [
    `[scheduled task "${name}", due ${scheduledAt}, set earlier in this conversation; not a new message from a person]`,
    `Do it now: ${task}`,
    "Post the outcome here. If it needs no message, call no_reply.",
  ].join("\n");
}
