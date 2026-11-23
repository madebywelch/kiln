import { defineTool } from "eve/tools";
import { z } from "zod";
import { prioritizeJob, resolveJobId } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";
import { launchNow } from "../lib/machines.ts";

export default defineTool({
  description:
    "Move a queued job ahead of older queued jobs, keeping its reference, files, and thread: it takes the next " +
    "free slot of its harness, after jobs continuing kept work. It doesn't stop running jobs. For a job that " +
    "can't wait its turn, such as one with a deadline.",
  inputSchema: z.object({
    job: z.string().describe("The queued job's reference, e.g. #46cd158a."),
  }),
  label: { start: ({ job }) => `Prioritize job ${job}` },
  async execute({ job: named }) {
    const job = await prioritizeJob(team, await resolveJobId(team, named));
    await launchNow();
    return { job: `#${job.ref}`, state: job.state, priority: job.priority };
  },
});
