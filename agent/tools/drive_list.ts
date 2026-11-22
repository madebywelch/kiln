import { defineTool } from "eve/tools";
import { z } from "zod";
import { driveFolder } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "List the files in your drive, or in one of its folders (projects/thanksgiving). Your drive is where you keep track of every project: see README.md in it.",
  inputSchema: z.object({
    folder: z
      .string()
      .optional()
      .describe("A folder, such as projects/thanksgiving. Default: the whole drive."),
  }),
  label: false,
  async execute({ folder }) {
    const entries = await (await drive()).list(driveFolder(folder));
    return {
      files: entries.map((e) => ({ path: e.path, bytes: e.size, updated: e.updatedAt.slice(0, 16) })),
    };
  },
});
