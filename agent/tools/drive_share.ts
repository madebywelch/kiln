import { defineTool } from "eve/tools";
import { z } from "zod";
import { drivePath } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";
import { slackHere, uploadToSlack } from "../lib/slack.ts";

export default defineTool({
  description:
    "Post a file from your drive into this Slack conversation, such as a plan or a screenshot you saved.",
  inputSchema: z.object({ path: z.string(), comment: z.string().optional() }),
  label: { start: ({ path }) => `Share ${path}` },
  async execute({ path, comment }, ctx) {
    const here = slackHere(ctx);
    if (!here) throw new Error("not in Slack: there is nowhere to post the file");
    const clean = drivePath(path);
    const file = await (await drive()).read(clean);
    if (!file) throw new Error(`no file at ${clean}`);
    await uploadToSlack({
      channel: here.channelId,
      threadTs: here.threadTs,
      filename: clean.split("/").at(-1) ?? clean,
      bytes: new Uint8Array(file.bytes),
      comment,
      teamId: here.teamId,
    });
    return { shared: clean, bytes: file.bytes.byteLength };
  },
});
