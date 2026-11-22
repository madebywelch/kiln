// Tasks people schedule in conversation: "in 5 hours, check the deploy", "every
// weekday at 9am Eastern, summarize open PRs". eve stores them in Vercel
// Schedules and fires them; each firing hands the task to the agent in the
// thread or channel where it was set. Experimental eve API.

import { defineDynamicSchedules } from "eve/experimental/schedules";
import { never } from "eve/tools/approval";
import { z } from "zod";
import slack from "../channels/slack.ts";
import { firingMessage, POST_WHERE, prepareTask } from "../lib/scheduled-task.ts";

export default defineDynamicSchedules({
  id: "tasks",
  description: [
    "Tasks you do later or on a repeat, set from a Slack conversation; each one comes back to you here when due.",
    'Timing: "in 5 hours" is { type: "delay", minutes: 300 }; "tomorrow at 3pm" is { type: "single", at: "YYYY-MM-DDTHH:mm",',
    'timezone }; "every day at 9am Eastern" is { type: "cron", cron: "0 9 * * *", timezone: "America/New_York" }.',
    "Use IANA timezones. If you don't know the person's, ask once and save it to memory. Cron fields are numeric",
    "(weekdays 0-6, Sunday is 0), and can't set both a day of the month and a day of the week.",
    "Write the task as the instruction you will act on, with what to check and what to post.",
  ].join(" "),
  inputSchema: z
    .object({
      task: z.string().min(1).max(2_000),
      post: z
        .enum(POST_WHERE)
        .default("thread")
        .describe(
          "thread: reply in this thread each time. channel: a new message in this channel each time.",
        ),
    })
    .strict(),
  preparePayload: (input, context) => prepareTask(input, context),
  // One set of schedules for the whole agent, as it has one memory: anyone it talks to can list or cancel them.
  scope: () => ["shared"],
  // A reminder shouldn't need a button press; the agent confirms in words.
  approval: {
    create: never(),
    update: never(),
    delete: never(),
    enable: never(),
    disable: never(),
    invoke: never(),
  },
  // The workspace is trusted as a whole (see README, Trust), so every creator may still run their schedules.
  auth: () => ({ attributes: {} }),
  async run({ payload, occurrence, to }) {
    await to(slack, {
      channelId: payload.channelId,
      ...(payload.threadTs ? { threadTs: payload.threadTs } : {}),
    }).send(firingMessage(payload.task, occurrence.displayName ?? occurrence.name, occurrence.scheduledAt));
  },
});
