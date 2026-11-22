import { defineTool } from "eve/tools";
import { z } from "zod";
import { MAX_FILE_BYTES, writeFile } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineTool({
  description: [
    "Create or replace a file in your drive. Write text with content, or save a file from your sandbox (a Slack attachment",
    "under /workspace/.eve/attachments, a chart you made) with sandbox_path. Keep INDEX.md current when you add or move things.",
    "Replacing a file replaces all of it: read it first and write the whole updated text.",
  ].join(" "),
  inputSchema: z
    .object({
      path: z.string().describe("Such as thanksgiving/plan.md or thanksgiving/assets/hero.png."),
      content: z.string().optional().describe("The whole text of the file."),
      sandbox_path: z.string().optional().describe("A file in your sandbox to save instead of text."),
    })
    .refine((input) => (input.content === undefined) !== (input.sandbox_path === undefined), {
      message: "pass content or sandbox_path, not both",
    }),
  label: { start: ({ path }) => `Save ${path}` },
  async execute({ path, content, sandbox_path }, ctx) {
    let bytes: Uint8Array;
    if (sandbox_path !== undefined) {
      const read = await (await ctx.getSandbox()).readBinaryFile({ path: sandbox_path });
      if (!read) throw new Error(`no file at ${sandbox_path} in the sandbox`);
      if (read.byteLength > MAX_FILE_BYTES)
        throw new Error(`files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      bytes = new Uint8Array(read);
    } else {
      bytes = new TextEncoder().encode(content ?? "");
    }
    const saved = await writeFile(await drive(), path, bytes);
    return { saved, bytes: bytes.byteLength };
  },
});
