import { defineTool } from "eve/tools";
import { z } from "zod";
import { readJob } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description: "Read one job: its state, who holds it, its result, and the worker's log of replies.",
  inputSchema: z.object({ id: z.string().describe("The job's number, e.g. 812.") }),
  label: { start: ({ id }) => `Read job #${id}` },
  async execute({ id }) {
    const { job, log } = await readJob(team, id);
    const { origin: _origin, ...rest } = job;
    return { ...rest, log };
  },
});
