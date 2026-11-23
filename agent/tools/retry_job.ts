import { defineTool } from "eve/tools";
import { z } from "zod";
import { resolveJobId, retryJob } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";
import { launchNow } from "../lib/machines.ts";

export default defineTool({
  description:
    "Run a failed job again, as it was: the same brief, files, harness, model, and effort, under the same " +
    "reference, reporting to the same thread. Its worker resumes any branch the last run pushed and sees why it " +
    "failed. Use it when the failure was passing, such as a rate limit or an outage; when the job itself needs " +
    "changing, start a new job instead.",
  inputSchema: z.object({ job: z.string().describe("The failed job's reference, e.g. #b799fe5c.") }),
  label: { start: ({ job }) => `Retry job ${job}` },
  async execute({ job: named }) {
    const job = await retryJob(team, await resolveJobId(team, named));
    await launchNow();
    return { job: `#${job.ref}`, state: job.state, runsOn: job.runsOn };
  },
});
