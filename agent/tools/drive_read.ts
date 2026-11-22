import { defineTool } from "eve/tools";
import { z } from "zod";
import { readText } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description:
    "Read a file from your drive. Text files (md, txt, json, csv, yaml, html, svg) come back as text; others as their size and type.",
  inputSchema: z.object({ path: z.string().describe("Such as thanksgiving/plan.md.") }),
  label: false,
  async execute({ path }) {
    return readText(await drive(), path);
  },
});
