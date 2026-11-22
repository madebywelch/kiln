import { defineTool } from "eve/tools";
import { z } from "zod";
import { SlackApiError, slackApi, slackHere } from "../lib/slack.ts";

export default defineTool({
  description:
    "Post a Slack message yourself instead of replying in the current thread. Use it to answer in the main " +
    "channel (omit thread_ts), to start a new thread elsewhere, to post into another thread, or to send a Block " +
    "Kit layout. By default this post is your reply and ends your turn; set final=false to keep working after it.",
  inputSchema: z.object({
    text: z.string().min(1).describe("The message in Markdown. With blocks, the notification fallback."),
    channel_id: z.string().optional().describe("Defaults to the current conversation's channel."),
    thread_ts: z
      .string()
      .optional()
      .describe("Post into this thread. Omit to post top-level in the channel."),
    blocks: z
      // An open object, not a record: OpenAI models reject the propertyNames a record becomes.
      .array(z.looseObject({ type: z.string() }))
      .max(50)
      .optional()
      .describe("Slack Block Kit blocks, for tables, sections, fields, buttons, and other rich layouts."),
    final: z.boolean().default(true).describe("Whether this post is your whole reply."),
  }),
  label: { start: ({ thread_ts }) => (thread_ts ? "Reply in thread" : "Post in channel") },
  async execute({ text, channel_id, thread_ts, blocks, final }, ctx) {
    const here = slackHere(ctx);
    const channel = channel_id ?? here?.channelId;
    if (!channel) throw new Error("no channel: this session is not in Slack, so pass channel_id");
    const base = { channel, text, ...(thread_ts ? { thread_ts } : {}), unfurl_links: false };
    let posted: Record<string, unknown>;
    try {
      posted = await slackApi(
        "chat.postMessage",
        { ...base, blocks: JSON.stringify(blocks ?? [{ type: "markdown", text }]) },
        here?.teamId,
      );
    } catch (error) {
      if (!(error instanceof SlackApiError && error.code.startsWith("invalid_blocks"))) throw error;
      posted = await slackApi("chat.postMessage", base, here?.teamId); // Slack refused the layout; send the text
    }
    return { channel, ts: String(posted.ts), endsTurn: final };
  },
  endsTurn: (output) => output.endsTurn,
});
