import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchDrive } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Search the text files in your drive for a word or phrase (case-insensitive), across everything or within a folder. Use it to find what you already know before asking or starting over.",
  inputSchema: z.object({
    query: z.string().min(1),
    folder: z.string().optional().describe("Limit the search to a folder, such as projects/analytics."),
  }),
  label: false,
  async execute({ query, folder }) {
    return { hits: await searchDrive(await drive(), query, folder) };
  },
});
