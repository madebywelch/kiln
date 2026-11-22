import { defineTool } from "eve/tools";
import { z } from "zod";
import { answerJob, resolveJobId } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "Pass a person's answer to a job that stopped with a question. The job goes back to the queue and the " +
    "next worker continues from its branch with the answer.",
  inputSchema: z.object({
    job: z.string().describe("The job's reference, e.g. #b799fe5c."),
    answer: z.string().min(1).describe("The answer, with any decision or context the worker needs."),
  }),
  label: { start: ({ job }) => `Answer job ${job}` },
  async execute({ job: named, answer }) {
    const job = await answerJob(team, await resolveJobId(team, named), answer);
    return { job: `#${job.ref}`, state: job.state };
  },
});
