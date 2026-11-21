import { defineTool } from "eve/tools";
import { z } from "zod";
import { cancelJob } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "Cancel a job. A worker running it stops at its next lease renewal, within two minutes. " +
    "Work it already pushed stays on its branch.",
  inputSchema: z.object({
    id: z.string(),
    reason: z.string().min(1).describe("Why, in a few words; recorded on the job."),
  }),
  label: { start: ({ id }) => `Cancel job #${id}` },
  async execute({ id, reason }) {
    const job = await cancelJob(team, id, reason);
    return { id: job.id, state: job.state };
  },
});
