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

/** Why a message did or did not reach the agent, for the log. */
export type RouteReason =
  | "bot"
  | "edit"
  | "addressed"
  | "followed-thread"
  | "unfollowed-thread"
  | "screened-out"
  | "ambient";

export interface RouteDecision {
  readonly result: SlackMentionResult | null;
  readonly reason: RouteReason;
}

export async function route(input: RouteInput): Promise<RouteDecision> {
  const { auth } = input;
  // Other bots, including the agent's own workers' notices, never start turns: two bots answering each other loop.
  if (input.fromBot) return { result: null, reason: "bot" };
  // Edits only reach threads that already have a session.
  if (input.edit) return { result: { auth, status: "deferred", guidance: THREAD_GUIDANCE }, reason: "edit" };

  if (input.mentioned || input.directMessage) {
    // A top-level message starts a new thread, so bring the conversation that led to it.
    const result = input.topLevel ? { auth, history: await input.history() } : { auth };
    return { result, reason: "addressed" };
  }

  if (!input.topLevel) {
    return (await input.isSubscribed())
      ? { result: { auth, status: "deferred", guidance: THREAD_GUIDANCE }, reason: "followed-thread" }
      : { result: null, reason: "unfollowed-thread" };
  }

  const history = await input.history();
  if (await input.clearlyNotForAgent(history)) return { result: null, reason: "screened-out" };
  return { result: { auth, status: "deferred", guidance: CHANNEL_GUIDANCE, history }, reason: "ambient" };
}

/** The auth attribute that carries a turn's route, so a failed turn knows whether a person is waiting on it. */
export const ROUTE_ATTRIBUTE = "kiln_route";

/** Tags a routed message's auth with why it reached the agent. */
export function withRoute(
  result: NonNullable<SlackMentionResult>,
  reason: RouteReason,
): NonNullable<SlackMentionResult> {
  if (!result.auth) return result;
  return {
    ...result,
    auth: { ...result.auth, attributes: { ...result.auth.attributes, [ROUTE_ATTRIBUTE]: reason } },
  };
}

/**
 * Whether a failed turn tells the thread. Only when a person spoke to the agent: a mention, a DM, or a reply in
 * a thread it is part of. A message it overheard, an edit, or a turn a schedule started (a job's report, a
 * check-back) fails quietly, in the log: when inference is down, every one of them would otherwise post an error.
 */
export function announcesFailure(turn: { readonly scheduled: boolean; readonly route: unknown }): boolean {
  return !turn.scheduled && (turn.route === "addressed" || turn.route === "followed-thread");
}
