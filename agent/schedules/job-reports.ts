// Every minute, hand each job a worker settled back to the Slack thread that
// asked for it. The agent then tells the thread in its own words.

import { defineSchedule } from "eve/schedules";
import { sweepReports } from "../../lib/board-jobs.ts";
import slack from "../channels/slack.ts";
import { team } from "../lib/board.ts";
import { uploadToSlack } from "../lib/slack.ts";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    waitUntil(
      sweepReports(
        team,
        (origin, message, idempotencyKey) =>
          to(slack, { channelId: origin.channelId, threadTs: origin.threadTs }).send(message, {
            auth: appAuth,
            idempotencyKey,
          }),
        (origin, file) =>
          uploadToSlack({
            channel: origin.channelId,
            threadTs: origin.threadTs,
            filename: file.name,
            bytes: file.bytes,
          }),
      ).then((result) => {
        if (result.delivered.length || result.failed.length) {
          console.info(JSON.stringify({ event: "job_reports.swept", ...result }));
        }
      }),
    );
  },
});
