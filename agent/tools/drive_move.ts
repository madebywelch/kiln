import { defineTool } from "eve/tools";
import { z } from "zod";
import { moveFile, removeFile } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Move or rename a file in your drive, or remove it by leaving out to. AGENTS.md stays where it is.",
  inputSchema: z.object({
    from: z.string(),
    to: z.string().optional().describe("The new path. Leave it out to remove the file."),
  }),
  label: { start: ({ from, to }) => (to ? `Move ${from} to ${to}` : `Remove ${from}`) },
  async execute({ from, to }) {
    const store = await drive();
    return to
      ? { moved: from, to: await moveFile(store, from, to) }
      : { removed: await removeFile(store, from) };
  },
});
