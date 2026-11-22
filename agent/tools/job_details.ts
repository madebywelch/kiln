import { defineTool } from "eve/tools";
import { z } from "zod";
import { readJob, resolveJobId } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description: "Read one job: its state, who holds it, its result, and the worker's log of replies.",
  inputSchema: z.object({ job: z.string().describe("The job's reference, e.g. #b799fe5c.") }),
  label: { start: ({ job }) => `Read job ${job}` },
  async execute({ job: named }) {
    const { job, log } = await readJob(team, await resolveJobId(team, named));
    const { origin: _origin, id: _id, ...rest } = job;
    return { ...rest, log };
  },
});
