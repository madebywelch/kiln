import { defaultSlackAuth, slackChannel } from "eve/channels/slack";
import { agent } from "../../lib/config.ts";
import { channelHistory, clearlyNotForAgent } from "../lib/ambient.ts";
import { route } from "../lib/route.ts";
import { slackCredentials } from "../lib/slack.ts";

export default slackChannel({
  credentials: slackCredentials,
  botName: agent.name,
  // Each thread's earlier replies, attributed. Within a session only what's new since the agent last spoke.
  threadContext: { since: "last-agent-reply" },
  messageContext: { users: {} },
  onMessage: (ctx, message) =>
    route({
      fromBot: message.author?.isBot !== false,
      topLevel: message.threadTs === message.ts,
      directMessage: message.raw.channel_type === "im",
      mentioned: ctx.isBotMentioned(),
      edit: ctx.edit !== undefined,
      auth: defaultSlackAuth(message, ctx),
      isSubscribed: () => ctx.isSubscribed(),
      history: () => channelHistory(ctx.slack, message),
      clearlyNotForAgent: (history) => clearlyNotForAgent(message, history),
    }),
});
