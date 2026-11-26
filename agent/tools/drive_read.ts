import { defineTool, toolOutput, toolOutputPart } from "eve/tools";
import { z } from "zod";
import { contentTypeOf, DriveError, drivePath, MAX_TEXT_READ, readText } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

/** Images the model can see, up to the size eve sends without warning. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

export default defineTool({
  description:
    "Read a file from your drive. Text files (md, txt, json, csv, yaml, html, svg) come back as text, up to 100,000 characters at a time: a longer one says where to read on (`next`), and a negative `offset` reads its end, such as -20000 for the newest part of a log. Images (PNG, JPEG, GIF, WebP up to 3 MB), such as a worker's screenshots, come back for you to look at; others as their size and type.",
  inputSchema: z.object({
    path: z.string().describe("Such as thanksgiving/plan.md."),
    offset: z
      .number()
      .int()
      .optional()
      .describe("Text only: the character to start at; negative counts back from the end. Default 0."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TEXT_READ)
      .optional()
      .describe("Text only: how many characters to read. Default and most 100,000."),
  }),
  label: false,
  async execute({ path, offset, limit }) {
    const store = await drive();
    const clean = drivePath(path);
    if (!IMAGE_TYPES.has(contentTypeOf(clean))) return readText(store, path, { offset, limit });
    const file = await store.read(clean);
    if (!file) throw new DriveError(`no file at ${clean}`);
    const about = { path: clean, contentType: contentTypeOf(clean), size: file.bytes.byteLength };
    if (about.size > MAX_IMAGE_BYTES)
      return { ...about, note: "too large to view: images are shown up to 3 MB" };
    return { ...about, image: Buffer.from(file.bytes).toString("base64") };
  },
  toModelOutput(output) {
    if (!("image" in output) || typeof output.image !== "string") return toolOutput.json(output);
    const { image, ...about } = output;
    return toolOutput.content([
      toolOutputPart.text(JSON.stringify(about)),
      toolOutputPart.file(image, { mediaType: about.contentType }),
    ]);
  },
});
