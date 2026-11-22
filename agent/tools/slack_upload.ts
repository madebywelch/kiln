import { defineTool } from "eve/tools";
import { z } from "zod";
import { slackHere, uploadToSlack } from "../lib/slack.ts";

const MAX_BYTES = 50 * 1024 * 1024;

export default defineTool({
  description:
    "Share a file in Slack: a document, a diagram, a CSV, an image you made, or a file from your sandbox. " +
    "Give either the text content or a path in your sandbox. Posts into the current thread by default.",
  inputSchema: z
    .object({
      filename: z
        .string()
        .min(1)
        .describe("Name shown in Slack, with an extension, e.g. plan.md or chart.png."),
      content: z.string().optional().describe("The file's text content."),
      sandbox_path: z.string().optional().describe("A file in your sandbox to upload instead of content."),
      comment: z.string().optional().describe("A message posted with the file."),
      channel_id: z.string().optional().describe("Defaults to the current conversation's channel."),
      thread_ts: z
        .string()
        .optional()
        .describe("Defaults to the current thread. Pass an empty string to post top-level."),
    })
    .refine((input) => (input.content === undefined) !== (input.sandbox_path === undefined), {
      message: "give exactly one of content or sandbox_path",
    }),
  label: { start: ({ filename }) => `Upload ${filename}` },
  async execute({ filename, content, sandbox_path, comment, channel_id, thread_ts }, ctx) {
    const here = slackHere(ctx);
    const channel = channel_id ?? here?.channelId;
    if (!channel) throw new Error("no channel: this session is not in Slack, so pass channel_id");
    const thread = thread_ts ?? (channel === here?.channelId ? here?.threadTs : undefined);

    let bytes: Uint8Array;
    if (sandbox_path !== undefined) {
      const sandbox = await ctx.getSandbox();
      const read = await sandbox.readBinaryFile({ path: sandbox_path });
      if (!read) throw new Error(`no file at ${sandbox_path} in the sandbox`);
      bytes = read;
    } else {
      bytes = new TextEncoder().encode(content ?? "");
    }
    if (bytes.byteLength === 0) throw new Error("the file is empty");
    if (bytes.byteLength > MAX_BYTES) throw new Error(`the file is over ${MAX_BYTES / 1024 / 1024} MB`);

    await uploadToSlack({
      channel,
      threadTs: thread,
      filename,
      bytes: new Uint8Array(bytes),
      comment,
      teamId: here?.teamId,
    });
    return { uploaded: filename, bytes: bytes.byteLength, channel, ...(thread ? { thread_ts: thread } : {}) };
  },
});
