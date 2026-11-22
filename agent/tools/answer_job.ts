import { defineTool } from "eve/tools";
import { z } from "zod";
import { answerJob } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "Pass a person's answer to a job that stopped with a question. The job goes back to the queue and the " +
    "next worker continues from its branch with the answer.",
  inputSchema: z.object({
    id: z.string(),
    answer: z.string().min(1).describe("The answer, with any decision or context the worker needs."),
  }),
  label: { start: ({ id }) => `Answer job #${id}` },
  async execute({ id, answer }) {
    const job = await answerJob(team, id, answer);
    return { id: job.id, state: job.state };
  },
});
