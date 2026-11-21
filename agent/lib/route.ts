// Which Slack messages reach the agent, and how. Pure, so every branch is tested
// without Slack: the channel passes in the context checks and the I/O.

import type { SessionHistoryMessage } from "eve/channels";
import type { defaultSlackAuth, SlackMentionResult } from "eve/channels/slack";

// Text written here, never message content: the model reads it as eve's own note.
export const THREAD_GUIDANCE =
  "You are part of this Slack thread, so you see replies people send each other. This reply doesn't " +
  "mention you. Answer only if it's meant for you or you hold something the thread plainly needs; " +
  "otherwise call `no_reply`.";
export const CHANNEL_GUIDANCE =
  "This message was posted in a channel you are in, without mentioning you. The messages before it are " +
  "in your history. Take part only if you are spoken to by name, or you have something specific and " +
  "useful to add; otherwise call `no_reply`.";

export interface RouteInput {
  readonly fromBot: boolean;
  readonly topLevel: boolean;
  readonly directMessage: boolean;
  readonly mentioned: boolean;
  readonly edit: boolean;
  readonly auth: ReturnType<typeof defaultSlackAuth>;
  readonly isSubscribed: () => Promise<boolean>;
  /** The channel's messages before this one. */
  readonly history: () => Promise<SessionHistoryMessage[]>;
  /** Whether a decision model is sure the message needs nothing from the agent. */
  readonly clearlyNotForAgent: (history: readonly SessionHistoryMessage[]) => Promise<boolean>;
}

export async function route(input: RouteInput): Promise<SlackMentionResult | null> {
  const { auth } = input;
  // Other bots, including the agent's own workers' notices, never start turns: two bots answering each other loop.
  if (input.fromBot) return null;
  // Edits only reach threads that already have a session.
  if (input.edit) return { auth, status: "deferred", guidance: THREAD_GUIDANCE };

  if (input.mentioned || input.directMessage) {
    // A top-level message starts a new thread, so bring the conversation that led to it.
    return input.topLevel ? { auth, history: await input.history() } : { auth };
  }

  if (!input.topLevel) {
    return (await input.isSubscribed()) ? { auth, status: "deferred", guidance: THREAD_GUIDANCE } : null;
  }

  const history = await input.history();
  if (await input.clearlyNotForAgent(history)) return null;
  return { auth, status: "deferred", guidance: CHANNEL_GUIDANCE, history };
}
