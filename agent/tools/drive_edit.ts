import { defineTool } from "eve/tools";
import { z } from "zod";
import { editFile } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Change part of a text file in your drive, such as AGENTS.md: replace `find`, copied exactly and occurring once, with `replace`; " +
    "or leave out `find` to add `replace` as a new line at the end. Pass an empty `replace` to delete the text.",
  inputSchema: z.object({
    path: z.string().describe("Such as AGENTS.md or thanksgiving/plan.md."),
    replace: z.string().describe("The new text, or the line to add."),
    find: z.string().optional().describe("The exact text to replace. Leave out to append."),
  }),
  label: { start: ({ path }) => `Edit ${path}` },
  async execute({ path, replace, find }) {
    return await editFile(await drive(), path, replace, find);
  },
});
