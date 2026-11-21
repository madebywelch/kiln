import { defineTool } from "eve/tools";
import { z } from "zod";
import { readable, type SlackRawMessage, slackApi, slackHere } from "../lib/slack.ts";

export default defineTool({
  description:
    "Read recent messages from a Slack channel, DM, or thread you are in: what was said before you were " +
    "brought in, a discussion in another channel, or a thread you are not part of. Oldest first.",
  inputSchema: z.object({
    channel_id: z.string().optional().describe("Defaults to the current conversation's channel."),
    thread_ts: z.string().optional().describe("Read this thread's replies instead of the channel."),
    limit: z.number().int().min(1).max(100).default(30),
  }),
  label: { start: ({ thread_ts }) => (thread_ts ? "Read thread" : "Read channel") },
  async execute({ channel_id, thread_ts, limit }, ctx) {
    const here = slackHere(ctx);
    const channel = channel_id ?? here?.channelId;
    if (!channel) throw new Error("no channel: this session is not in Slack, so pass channel_id");
    const response = thread_ts
      ? await slackApi("conversations.replies", { channel, ts: thread_ts, limit }, here?.teamId)
      : await slackApi("conversations.history", { channel, limit }, here?.teamId);
    const messages = await readable((response.messages ?? []) as SlackRawMessage[], here?.teamId);
    return { channel, ...(thread_ts ? { thread_ts } : {}), messages };
  },
});
