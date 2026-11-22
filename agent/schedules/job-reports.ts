// Every minute, hand each job a worker settled back to the Slack thread that
// asked for it. The agent then tells the thread in its own words. Files the
// worker returned are saved in the agent's drive under jobs/<ref>/, so it can
// keep working on them or hand them to the next job. They are not posted: each
// post notifies people, so the agent shares one (drive_share) only when someone
// needs to see it.

import { defineSchedule } from "eve/schedules";
import { jobFilesFolder, sweepReports } from "../../lib/board-jobs.ts";
import { driveName, writeFile } from "../../lib/drive.ts";
import slack from "../channels/slack.ts";
import { team } from "../lib/board.ts";
import { drive } from "../lib/drive.ts";

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
        },
      ).then((result) => {
        if (result.delivered.length || result.failed.length) {
          console.info(JSON.stringify({ event: "job_reports.swept", ...result }));
        }
      }),
    );
  },
});
