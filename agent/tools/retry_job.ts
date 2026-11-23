import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveJobId, retryJob } from "../../lib/board-jobs.ts";
import { discardKeptMachine } from "../../lib/machines.ts";
import { team } from "../lib/board.ts";
import { boatClient, launchNow } from "../lib/machines.ts";

export default defineTool({
  description:
    "Run a failed job again, as it was: the same brief, files, harness, model, and effort, under the same " +
    "reference, reporting to the same thread. When its work is kept (job_details says workKept), it continues " +
    "on its own machine, in the same session, where it stopped; otherwise it starts over and sees why it " +
    "failed. Use it when the failure was passing, such as a rate limit or an outage; when the job itself needs " +
    "changing, start a new job instead.",
  inputSchema: z.object({
    job: z.string().describe("The failed job's reference, e.g. #b799fe5c."),
    fresh: z
      .boolean()
      .default(false)
      .describe(
        "Throw away the kept work and start over from a fresh clone, such as when the last run went wrong.",
      ),
  }),
  label: { start: ({ job }) => `Retry job ${job}` },
  async execute({ job: named, fresh }) {
    const id = await resolveJobId(team, named);
    if (fresh) {
      const boat = boatClient();
      if (typeof boat !== "string") await discardKeptMachine({ team, boat }, id);
    }
    const job = await retryJob(team, id);
    await launchNow();
    return {
      job: `#${job.ref}`,
      state: job.state,
      runsOn: job.runsOn,
      continues: job.workKept ? "from its kept work" : "from the start",
    };
  },
});
