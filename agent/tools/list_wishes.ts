import { defineTool } from "eve/tools";
import { z } from "zod";
import { listWishes } from "../../lib/wishes.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description:
    "List the wish list: limitations in kiln or eve you have reported, most recently active last. Open wishes are " +
    "waiting for review; completed ones were built and failed ones won't be, each with a note saying why.",
  inputSchema: z.object({
    state: z.enum(["open", "all"]).default("open"),
    limit: z.number().int().min(1).max(50).default(30),
  }),
  label: { start: () => "List wishes" },
  async execute({ state, limit }) {
    return { wishes: await listWishes(team, state, limit) };
  },
});
