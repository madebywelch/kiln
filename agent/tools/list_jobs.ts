import { defineTool } from "eve/tools";
import { z } from "zod";
import { listJobs } from "../../lib/board-jobs.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "List jobs in the worker pool, most recently active last: what is queued, running, blocked, or done.",
  inputSchema: z.object({
    state: z
      .enum(["open", "all", "ready", "claimed", "blocked", "completed", "failed", "canceled"])
      .default("open")
      .describe("open means not finished: ready, claimed, blocked, or waiting."),
    limit: z.number().int().min(1).max(50).default(15),
  }),
  label: { start: () => "List jobs" },
  async execute({ state, limit }) {
    const jobs = await listJobs(team, { state, limit });
    return { jobs: jobs.map(({ origin: _origin, ...job }) => job) };
  },
});
