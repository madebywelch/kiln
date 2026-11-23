// Every minute: a machine for each ready job, within each harness's limit; a
// stopped one for a job whose work is kept; none for jobs that are over. See
// lib/machines.ts.

import { defineSchedule } from "eve/schedules";
import { reconcileMachines } from "../../lib/machines.ts";
import { log, machineDeps } from "../lib/machines.ts";

export default defineSchedule({
  cron: "* * * * *",
  async run({ waitUntil }) {
    const deps = machineDeps();
    if (typeof deps === "string") {
      log("machines.unconfigured", { problem: deps });
      return;
    }
    waitUntil(
      reconcileMachines(deps).then(
        (result) => {
          if (
            result.launched.length ||
            result.resumed.length ||
            result.stopped.length ||
            result.deleted.length ||
            result.failed.length
          ) {
            log("machines.reconciled", { ...result });
          }
        },
        (error: unknown) => log("machines.reconcile_failed", { error: String(error) }),
      ),
    );
  },
});
