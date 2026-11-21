// Every minute: a machine for each ready job, within each harness's limit, and
// none for jobs that are over. See lib/machines.ts.

import { defineSchedule } from "eve/schedules";
import { viewJob, waitingMessage } from "../../lib/board-jobs.ts";
import { reconcileMachines } from "../../lib/machines.ts";
import slack from "../channels/slack.ts";
import { log, machineDeps } from "../lib/machines.ts";

export default defineSchedule({
  cron: "* * * * *",
  async run({ to, waitUntil, appAuth }) {
    const deps = machineDeps(async (message, until) => {
      const job = viewJob(message);
      if (!job.origin) return;
      await to(slack, { channelId: job.origin.channelId, threadTs: job.origin.threadTs }).send(
        waitingMessage(job, until),
        { auth: appAuth, idempotencyKey: `waiting:${job.id}:${until}` },
      );
    });
    if (typeof deps === "string") {
      log("machines.unconfigured", { problem: deps });
      return;
    }
    waitUntil(
      reconcileMachines(deps).then(
        (result) => {
          if (
            result.launched.length ||
            result.deleted.length ||
            result.failed.length ||
            result.exhausted.length
          ) {
            log("machines.reconciled", { ...result });
          }
        },
        (error: unknown) => log("machines.reconcile_failed", { error: String(error) }),
      ),
    );
  },
});
