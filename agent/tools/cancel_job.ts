import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelJob, resolveJobId } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "Cancel a job. A worker running it stops at its next lease renewal, within two minutes. " +
    "Work it already pushed stays on its branch.",
  inputSchema: z.object({
    job: z.string().describe("The job's reference, e.g. #b799fe5c."),
    reason: z.string().min(1).describe("Why, in a few words; recorded on the job."),
  }),
  label: { start: ({ job }) => `Cancel job ${job}` },
  async execute({ job: named, reason }) {
    const job = await cancelJob(team, await resolveJobId(team, named), reason);
    return { job: `#${job.ref}`, state: job.state };
  },
});
