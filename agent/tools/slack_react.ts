import { defineTool } from "eve/tools";
import { z } from "zod";
import { SlackApiError, slackApi, slackHere } from "../lib/slack.ts";

export default defineTool({
  description:
    "Add an emoji reaction to a Slack message, the way a teammate would: to acknowledge without a message, " +
    "to agree, or to mark something done. Take the message_ts from the message's <thread> block. " +
    "When a reaction is your whole answer, call no_reply after it.",
  inputSchema: z.object({
    emoji: z
      .string()
      .min(1)
      .describe("Emoji name without colons, e.g. eyes, white_check_mark, fire, thumbsup."),
    message_ts: z.string().describe("The ts of the message to react to."),
    channel_id: z.string().optional().describe("Defaults to the current conversation's channel."),
  }),
  label: false,
  async execute({ emoji, message_ts, channel_id }, ctx) {
    const here = slackHere(ctx);
    const channel = channel_id ?? here?.channelId;
    if (!channel) throw new Error("no channel: this session is not in Slack, so pass channel_id");
    try {
      await slackApi(
        "reactions.add",
        { channel, timestamp: message_ts, name: emoji.replaceAll(":", "") },
        here?.teamId,
      );
    } catch (error) {
      if (!(error instanceof SlackApiError && error.code === "already_reacted")) throw error;
    }
    return { reacted: emoji };
  },
});
