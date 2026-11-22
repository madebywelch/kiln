import { defineTool } from "eve/tools";
import { z } from "zod";
import { readText } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Read a file from your drive. Text files (md, txt, json, csv, yaml, html, svg) come back as text; others as their size and type. Read a project's PROJECT.md before working on it.",
  inputSchema: z.object({ path: z.string().describe("Such as projects/thanksgiving/PROJECT.md.") }),
  label: false,
  async execute({ path }) {
    return readText(await drive(), path);
  },
});
