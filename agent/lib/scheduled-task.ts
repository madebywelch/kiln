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

/** A stored task as the schedules client lists it: what `list_tasks` needs of a ScheduleRecord. */
export interface TaskRecord {
  readonly name: string;
  readonly displayName?: string;
  readonly state: "active" | "inactive" | "completed";
  readonly expression:
    | { readonly type: "cron"; readonly cron: string; readonly timezone?: string }
    | { readonly type: "single"; readonly at: string; readonly timezone?: string };
}

/** The instant a `YYYY-MM-DDTHH:mm` wall-clock time in an IANA timezone names, in ms since the epoch. */
export function instantOf(at: string, timezone = "UTC"): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(at);
  if (!match) return Number.NaN;
  const [, y, mo, d, h, mi] = match.map(Number) as number[];
  const wall = Date.UTC(y as number, (mo as number) - 1, d, h, mi);
  // The zone's offset at a moment: its wall clock then, read as UTC, minus the moment.
  const offsetAt = (moment: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
        .formatToParts(moment)
        .map((part) => [part.type, part.value]),
    );
    return (
      Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        Number(parts.hour),
        Number(parts.minute),
      ) - moment
    );
  };
  // Twice, so a time on the other side of a daylight-saving change gets that side's offset.
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

/** A one-time task whose time has passed: it has fired (or was missed) and won't fire again. */
export function isSpent(record: TaskRecord, now: number): boolean {
  if (record.state === "completed") return true;
  return (
    record.expression.type === "single" && instantOf(record.expression.at, record.expression.timezone) <= now
  );
}

/** Tasks still to come, soonest one-time task first, then the recurring ones; disabled ones say so. */
export function pendingTasks(records: readonly TaskRecord[], now: number, query?: string) {
  const needle = query?.trim().toLowerCase();
  return records
    .filter((record) => !isSpent(record, now))
    .filter(
      (record) => !needle || `${record.name} ${record.displayName ?? ""}`.toLowerCase().includes(needle),
    )
    .map((record) => ({
      name: record.name,
      ...(record.displayName ? { label: record.displayName } : {}),
      ...(record.expression.type === "single"
        ? { runs: `once, ${record.expression.at} ${record.expression.timezone ?? "UTC"}` }
        : { runs: `cron ${record.expression.cron} ${record.expression.timezone ?? "UTC"}` }),
      ...(record.state === "inactive" ? { disabled: true } : {}),
      sort:
        record.expression.type === "single"
          ? instantOf(record.expression.at, record.expression.timezone)
          : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ sort: _sort, ...task }) => task);
}
