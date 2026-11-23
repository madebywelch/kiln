import { defaultSlackAuth, defineSlackRenderer, slackChannel } from "eve/channels/slack";
import { agentName } from "../../lib/deployment.ts";
import { channelHistory, clearlyNotForAgent } from "../lib/ambient.ts";
import { announcesFailure, ROUTE_ATTRIBUTE, route, withRoute } from "../lib/route.ts";
import { conversationContext, slackCredentials } from "../lib/slack.ts";

// eve posts "I hit an error while handling your request" in the thread of every failed turn. When inference is
// down that is every turn: each job report, check-back, and overheard message posts one. Post it only where a
// person is waiting; elsewhere log it and let eve clear the thread status as for a finished turn.
const quietFailures = defineSlackRenderer({
  events: {
    async "turn.settled"(event, ctx, next) {
      if (event.data.outcome !== "failed") return next();
      const turn = {
        scheduled: ctx.session.schedule !== undefined,
        route: ctx.session.auth.current?.attributes[ROUTE_ATTRIBUTE],
      };
      if (announcesFailure(turn)) return next();
      console.warn(
        JSON.stringify({
          event: "turn.failed_quietly",
          ...turn,
          schedule: ctx.session.schedule?.definition ?? null,
          error: event.data.error?.id ?? null,
          hint: event.data.error?.hint ?? null,
        }),
      );
      return next({ ...event, data: { ...event.data, outcome: "completed" } });
    },
  },
});

export default slackChannel({
  credentials: slackCredentials,
  renderers: [quietFailures],
  botName: agentName(),
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
    const routed = withRoute(result, reason);
    // Which channel this is, by name: eve passes only its ID, and a channel named after a project says what it's about.
    const where = await conversationContext(message.channelId, message.teamId);
    return where ? { ...routed, context: [...(routed.context ?? []), where] } : routed;
  },
});
