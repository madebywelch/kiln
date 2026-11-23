// Slack access shared by the channel, tools, and schedules.
//
// Credentials: with SLACK_CONNECTOR set (a Vercel Connect connector UID, e.g.
// `slack/<your app>`), Connect holds the bot token and verifies requests. Without
// it, the channel reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.

import { connectSlackCredentials } from "@vercel/connect/eve";
import { callSlackApi } from "eve/channels/slack";

const connector = process.env.SLACK_CONNECTOR;

export const slackCredentials = connector ? connectSlackCredentials(connector) : undefined;

export class SlackApiError extends Error {
  override readonly name = "SlackApiError";
  readonly code: string;
  constructor(operation: string, code: string) {
    super(`Slack ${operation} failed: ${code}`);
    this.code = code;
  }
}

export type SlackResponse = Record<string, unknown> & { ok: boolean };

/** Calls the Slack Web API with the bot token. Throws SlackApiError on `ok: false`. */
export async function slackApi(
  operation: string,
  body: Record<string, unknown>,
  teamId?: string,
): Promise<SlackResponse> {
  const response = (await callSlackApi({
    botToken: slackCredentials?.botToken,
    ...(teamId ? { context: { teamId } } : {}),
    operation,
    body,
  })) as SlackResponse;
  if (!response.ok) throw new SlackApiError(operation, String(response.error ?? "unknown_error"));
  return response;
}

let selfId: Promise<string | undefined> | undefined;

/** The agent's own Slack user ID, from `auth.test`, cached for the life of the process. */
export function botUserId(teamId?: string): Promise<string | undefined> {
  selfId ??= slackApi("auth.test", {}, teamId).then(
    (response) => (typeof response.user_id === "string" ? response.user_id : undefined),
    () => {
      selfId = undefined; // try again next time
      return undefined;
    },
  );
  return selfId;
}

interface ConversationInfo {
  readonly name?: string;
  readonly is_im?: boolean;
  readonly is_mpim?: boolean;
}

/** Where a conversation is, in words the model reads: "#guaca", a DM, or a group DM. */
export function conversationLabel(info: ConversationInfo): string | undefined {
  if (info.is_im) return "a direct message";
  if (info.is_mpim) return "a group direct message";
  return info.name ? `#${info.name}` : undefined;
}

const conversations = new Map<string, string>();

/**
 * One line of per-turn context naming the conversation a message is in, such as "This conversation
 * is in the Slack channel #guaca." eve gives the agent only the channel's ID. Cached for the life of
 * the process; undefined on any Slack error, so a missing scope costs context, not the message.
 */
export async function conversationContext(channelId: string, teamId?: string): Promise<string | undefined> {
  let label = conversations.get(channelId);
  if (!label) {
    try {
      const response = await slackApi("conversations.info", { channel: channelId }, teamId);
      label = conversationLabel((response.channel ?? {}) as ConversationInfo);
    } catch (error) {
      const code = error instanceof SlackApiError ? error.code : String(error);
      console.warn(JSON.stringify({ event: "slack.conversation_unnamed", channel: channelId, error: code }));
      return undefined;
    }
    if (!label) return undefined;
    conversations.set(channelId, label);
  }
  return label.startsWith("#")
    ? `This conversation is in the Slack channel ${label}.`
    : `This conversation is in ${label}.`;
}

const names = new Map<string, string>();

/** A person's display name, cached for the life of the process. Falls back to the ID. */
export async function userName(userId: string, teamId?: string): Promise<string> {
  const cached = names.get(userId);
  if (cached) return cached;
  try {
    const response = await slackApi("users.info", { user: userId }, teamId);
    const user = response.user as { profile?: { display_name?: string; real_name?: string }; name?: string };
    const name = user.profile?.display_name || user.profile?.real_name || user.name || userId;
    names.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

export interface SlackRawMessage {
  readonly ts: string;
  readonly user?: string;
  readonly bot_id?: string;
  readonly text?: string;
  readonly thread_ts?: string;
  readonly reply_count?: number;
  readonly subtype?: string;
  readonly files?: readonly { readonly name?: string }[];
}

export interface ReadableMessage {
  readonly ts: string;
  readonly thread_ts?: string;
  readonly from: string;
  readonly bot: boolean;
  readonly text: string;
  readonly replies?: number;
}

/** Turns raw Slack messages into what a model reads: who said what, in order, oldest first. */
export async function readable(
  messages: readonly SlackRawMessage[],
  teamId?: string,
): Promise<ReadableMessage[]> {
  const kept = messages.filter(
    (message) =>
      !message.subtype || message.subtype === "file_share" || message.subtype === "thread_broadcast",
  );
  const out = await Promise.all(
    kept.map(async (message) => {
      const files = message.files?.map((file) => `[file: ${file.name ?? "unnamed"}]`).join(" ") ?? "";
      return {
        ts: message.ts,
        ...(message.thread_ts && message.thread_ts !== message.ts ? { thread_ts: message.thread_ts } : {}),
        from: message.user ? `${await userName(message.user, teamId)} <@${message.user}>` : "a bot",
        bot: Boolean(message.bot_id),
        text: [message.text ?? "", files].filter(Boolean).join(" "),
        ...(message.reply_count ? { replies: message.reply_count } : {}),
      };
    }),
  );
  return out.sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** Where a tool call is happening in Slack, when the session is a Slack thread. */
export interface SlackHere {
  readonly channelId: string;
  readonly threadTs: string | undefined;
  readonly teamId: string | undefined;
}

export function slackHere(ctx: {
  readonly channel?: { readonly kind?: string; readonly metadata?: unknown };
}): SlackHere | undefined {
  const metadata = ctx.channel?.metadata as
    | { channelId?: string | null; threadTs?: string | null; teamId?: string | null }
    | undefined;
  if (!metadata?.channelId) return undefined;
  return {
    channelId: metadata.channelId,
    threadTs: metadata.threadTs ?? undefined,
    teamId: metadata.teamId ?? undefined,
  };
}

/** Where a job's updates go: a Slack channel and a thread in it. */
export interface ReportThread {
  readonly channelId: string;
  readonly threadTs: string;
}

/** The shapes of the IDs a report target names, checked before anything is posted. */
export const SLACK_CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
export const SLACK_THREAD_TS = /^\d+\.\d+$/;

/**
 * The thread a job reports to. By default the one this turn is in, if any. A named thread is used as
 * is (in the named channel, or this one). A channel named without a thread gets a short opener, posted
 * now, whose thread then holds every update of the job: eve would otherwise start a new thread per update.
 */
export async function reportThread(
  want: { readonly channelId?: string | undefined; readonly threadTs?: string | undefined },
  here: SlackHere | undefined,
  opener: string,
): Promise<ReportThread | undefined> {
  const channelId = want.channelId ?? here?.channelId;
  if (!want.channelId && !want.threadTs)
    return here?.threadTs ? { channelId: here.channelId, threadTs: here.threadTs } : undefined;
  if (!channelId) throw new Error("thread_ts needs channel_id outside Slack: name the channel too");
  if (!SLACK_CHANNEL_ID.test(channelId))
    throw new Error(`channel_id ${channelId} is not a Slack channel ID, such as C0123ABCD`);
  if (want.threadTs) {
    if (!SLACK_THREAD_TS.test(want.threadTs))
      throw new Error(
        `thread_ts ${want.threadTs} is not a Slack message timestamp, such as 1795393911.357859`,
      );
    return { channelId, threadTs: want.threadTs };
  }
  const posted = await slackApi("chat.postMessage", { channel: channelId, text: opener }, here?.teamId);
  if (typeof posted.ts !== "string") throw new Error("Slack posted the thread opener without a timestamp");
  return { channelId, threadTs: posted.ts };
}

/** What start_job tells the agent about where the job's updates will go. */
export function reportsTo(origin: ReportThread | undefined, here: SlackHere | undefined): string {
  if (!origin) return "nowhere";
  if (origin.channelId === here?.channelId && origin.threadTs === here.threadTs) return "this thread";
  return `<#${origin.channelId}>, thread ${origin.threadTs}`;
}

/** Uploads a file into a channel or thread: ask Slack for an upload URL, send the bytes, then share the file. */
export async function uploadToSlack(input: {
  readonly channel: string;
  readonly threadTs?: string | undefined;
  readonly filename: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  readonly comment?: string | undefined;
  readonly teamId?: string | undefined;
}): Promise<void> {
  const ticket = await slackApi(
    "files.getUploadURLExternal",
    { filename: input.filename, length: input.bytes.byteLength },
    input.teamId,
  );
  const upload = await fetch(String(ticket.upload_url), { method: "POST", body: input.bytes });
  if (!upload.ok) throw new Error(`Slack refused the file upload: HTTP ${upload.status}`);
  const share = (comment: Record<string, string>) =>
    slackApi(
      "files.completeUploadExternal",
      {
        files: JSON.stringify([{ id: ticket.file_id, title: input.filename }]),
        channel_id: input.channel,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        ...comment,
      },
      input.teamId,
    );
  if (!input.comment) {
    await share({});
    return;
  }
  // The comment is Markdown, as in slack_post, which a markdown block renders; initial_comment
  // takes Slack's own mrkdwn and showed Markdown raw.
  try {
    await share({ blocks: JSON.stringify([{ type: "markdown", text: input.comment }]) });
  } catch (error) {
    if (!(error instanceof SlackApiError && REFUSED_BLOCKS.has(error.code))) throw error;
    console.warn(JSON.stringify({ event: "slack.upload_blocks_refused", error: error.code }));
    await share({ initial_comment: markdownToMrkdwn(input.comment) });
  }
}

/** Errors Slack answers a share with when it won't take its comment as blocks. */
const REFUSED_BLOCKS = new Set(["invalid_blocks", "invalid_blocks_format", "invalid_arguments"]);

/** The Markdown the agent writes, in Slack's mrkdwn: bold, strikethrough, links, headings, and bullets. */
export function markdownToMrkdwn(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, "<$2|$1>")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ");
}
