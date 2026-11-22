import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { agent } from "../../lib/config.ts";
import { channelHistory, clearlyNotForAgent } from "../lib/ambient.ts";
import { route } from "../lib/route.ts";
import { conversationContext, slackCredentials } from "../lib/slack.ts";

export default slackChannel({
  credentials: slackCredentials,
  botName: agent.name,
  // Each thread's earlier replies, attributed. Within a session only what's new since the agent last spoke.
  threadContext: { since: "last-agent-reply" },
  messageContext: { users: {} },
  async onMessage(ctx, message) {
    const topLevel = message.threadTs === message.ts;
    const { result, reason } = await route({
      fromBot: message.author?.isBot !== false,
      topLevel,
      directMessage: message.raw.channel_type === "im",
      mentioned: ctx.isBotMentioned(),
      edit: ctx.edit !== undefined,
      auth: defaultSlackAuth(message, ctx),
      isSubscribed: () => ctx.isSubscribed(),
      history: () => channelHistory(ctx.slack, message),
      clearlyNotForAgent: (history) => clearlyNotForAgent(message, history),
    });
    // One line per message, never its text: why it did or did not reach the agent.
    console.info(
      JSON.stringify({
        event: "slack.route",
        channel: message.channelId,
        ts: message.ts,
        thread: topLevel ? null : message.threadTs,
        reason,
        delivered: result !== null,
      }),
    );
    if (!result) return null;
    // Which channel this is, by name: eve passes only its ID, and a channel named after a project says what it's about.
    const where = await conversationContext(message.channelId, message.teamId);
    return where ? { ...result, context: [...(result.context ?? []), where] } : result;
  },
});
