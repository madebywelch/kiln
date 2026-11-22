// Every minute, hand each job a worker settled back to the Slack thread that
// asked for it. The agent then tells the thread in its own words. Files the
// worker returned are saved in the agent's drive under jobs/<id>/, so it can
// keep working on them or hand them to the next job, and posted in the thread.

import { defineSchedule } from "eve/schedules";
import { jobFilesFolder, sweepReports } from "../../lib/board-jobs.ts";
import { driveName, writeFile } from "../../lib/drive.ts";
import slack from "../channels/slack.ts";
import { team } from "../lib/board.ts";
import { drive } from "../lib/drive.ts";
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
        async (job, file) => {
          await writeFile(await drive(), `${jobFilesFolder(job.id)}${driveName(file.name)}`, file.bytes);
          if (job.origin) {
            await uploadToSlack({
              channel: job.origin.channelId,
              threadTs: job.origin.threadTs,
              filename: file.name,
              bytes: file.bytes,
            });
          }
        },
      ).then((result) => {
        if (result.delivered.length || result.failed.length) {
          console.info(JSON.stringify({ event: "job_reports.swept", ...result }));
        }
      }),
    );
  },
});
