import { defineTool } from "eve/tools";
import { z } from "zod";
import { makeWish } from "../../lib/wishes.ts";
import { team } from "../lib/board.ts";

export default defineTool({
  description: [
    "Tell the people who build kiln about a limitation you ran into in kiln or eve itself: a tool you",
    "don't have, a tool that fails or isn't offered in some kind of turn, a permission or reach you lack.",
    "Use it when a limitation stopped or degraded real work, then carry on as best you can. It is not for",
    "this workspace's own business (workflows, repos, people, preferences: those go in your drive), for",
    "things you can do yourself, or for things a person here can give you, such as a secret. Check",
    "list_wishes first: when an open wish covers it, pass adds_to with that wish, so each limitation is one",
    "wish with every time it got in the way. Never include secret values.",
  ].join(" "),
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .max(120)
      .describe("The limitation in one line, such as `Can't schedule a check-back from a job-update turn`."),
    detail: z
      .string()
      .min(1)
      .max(4000)
      .describe(
        "What you were doing, what stopped you (the error, if there was one), what you did instead, and what would have let you do it.",
      ),
    adds_to: z.string().optional().describe("An open wish this is another sighting of, such as #1a2b3c4d."),
  }),
  label: { start: ({ summary }) => `Wish: ${summary}` },
  async execute({ summary, detail, adds_to }) {
    return await makeWish(team, { summary, detail }, adds_to);
  },
});
