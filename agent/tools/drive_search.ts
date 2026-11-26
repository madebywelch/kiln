import { defineTool } from "eve/tools";
import { z } from "zod";
import { searchDrive } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Search the text files in your drive for a word or phrase (case-insensitive), across everything or within a folder. Use it to find what you already know before asking or starting over. Each hit is a matching line, cut at 1,000 characters, with its `offset` in the file: drive_read from there for the whole line and what follows.",
  inputSchema: z.object({
    query: z.string().min(1),
    folder: z.string().optional().describe("Limit the search to a folder."),
  }),
  label: false,
  async execute({ query, folder }) {
    return { hits: await searchDrive(await drive(), query, folder) };
  },
});
