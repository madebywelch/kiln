// Collecting a repo secret in Slack without a model ever seeing it.
//
// The agent posts a "Set NAME" button (request_secret). A click opens a modal;
// its submission goes straight to boat. eve's Slack channel drops modal
// payloads it didn't create, so Slack's interactivity URL points at
// /slack/interactivity (agent/channels/slack-interactivity.ts): it handles the
// button and the modal here and forwards every other payload, byte for byte,
// to eve's Slack route.

import { createHmac, timingSafeEqual } from "node:crypto";
import { repos } from "../../lib/config.ts";
import { environmentName, secretNameIssue } from "../../lib/secrets.ts";

export const OPEN_ACTION_ID = "kiln_secret_open";
export const MODAL_CALLBACK_ID = "kiln_secret";
const INPUT_BLOCK_ID = "secret";
const INPUT_ACTION_ID = "value";
const MAX_SIGNATURE_AGE_SECONDS = 300;

export interface SecretRequest {
  readonly repo: string;
  readonly name: string;
}

interface ModalContext extends SecretRequest {
  readonly channel: string;
  readonly thread: string | undefined;
}

/** Slack's request signature: v0=HMAC-SHA256(secret, "v0:<timestamp>:<body>"), within five minutes. */
export function verifySlackSignature(
  body: string,
  timestamp: string | null,
  signature: string | null,
  secret: string,
  nowSeconds: number,
): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SIGNATURE_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The message the agent posts to ask for a secret: what it's for, and a button. */
export function requestBlocks(request: SecretRequest, why: string): Record<string, unknown>[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${request.repo}* needs \`${request.name}\`. ${why}`.trim(),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: OPEN_ACTION_ID,
          text: { type: "plain_text", text: `Set ${request.name}` },
          value: JSON.stringify(request),
          style: "primary",
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Stored in boat environment \`${environmentName(request.repo)}\`. Only jobs on ${request.repo} see it, and the agent never does.`,
        },
      ],
    },
  ];
}

export function secretModal(context: ModalContext): Record<string, unknown> {
  return {
    type: "modal",
    callback_id: MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify(context),
    title: { type: "plain_text", text: "Set a repo secret" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `\`${context.name}\` for *${context.repo}*. Saved to boat environment \`${environmentName(context.repo)}\`; jobs on this repo get it as an environment variable. Setting it again replaces it.`,
        },
      },
      {
        type: "input",
        block_id: INPUT_BLOCK_ID,
        label: { type: "plain_text", text: context.name },
        element: { type: "plain_text_input", action_id: INPUT_ACTION_ID },
      },
    ],
  };
}

function noticeModal(title: string, text: string): Record<string, unknown> {
  return {
    type: "modal",
    title: { type: "plain_text", text: title },
    close: { type: "plain_text", text: "Close" },
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
}

export interface InteractivityDeps {
  readonly signingSecret: string | undefined;
  /** Slack user IDs allowed to set secrets. */
  readonly admins: ReadonlySet<string>;
  readonly openView: (triggerId: string, view: Record<string, unknown>) => Promise<unknown>;
  readonly setSecret: (repo: string, name: string, value: string) => Promise<void>;
  readonly postMessage: (channel: string, thread: string | undefined, text: string) => Promise<unknown>;
  /** Hands a payload that isn't kiln's to eve's Slack route. */
  readonly forward: (body: string, headers: Headers) => Promise<Response>;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
  readonly nowSeconds?: () => number;
}

export function parseAdmins(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

const notAllowed = (userId: string) =>
  `Only kiln's operators can set repo secrets. Ask one to add your Slack user ID, \`${userId}\`, to \`KILN_SECRET_ADMINS\` on the agent's Vercel project.`;

function parseRequest(value: unknown): SecretRequest | null {
  try {
    const parsed = JSON.parse(String(value)) as Partial<SecretRequest>;
    if (typeof parsed.repo === "string" && typeof parsed.name === "string" && repos[parsed.repo]) {
      return { repo: parsed.repo, name: parsed.name };
    }
  } catch {
    // not ours
  }
  return null;
}

interface SlackPayload {
  type?: string;
  trigger_id?: string;
  user?: { id?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: { action_id?: string; value?: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}

/** Handles Slack's interactivity webhook: kiln's secret button and modal here, everything else to eve. */
export async function handleInteractivity(request: Request, deps: InteractivityDeps): Promise<Response> {
  const body = await request.text();
  if (!deps.signingSecret) {
    deps.log("secrets.interactivity_unconfigured", { problem: "SLACK_SIGNING_SECRET is not set" });
    return deps.forward(body, request.headers);
  }
  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  if (
    !verifySlackSignature(
      body,
      request.headers.get("x-slack-request-timestamp"),
      request.headers.get("x-slack-signature"),
      deps.signingSecret,
      now,
    )
  ) {
    return new Response("invalid signature", { status: 401 });
  }

  let payload: SlackPayload;
  try {
    payload = JSON.parse(new URLSearchParams(body).get("payload") ?? "") as SlackPayload;
  } catch {
    return deps.forward(body, request.headers); // a slash command or something else eve understands
  }
  const userId = payload.user?.id ?? "";

  const open =
    payload.type === "block_actions" && payload.actions?.find((a) => a.action_id === OPEN_ACTION_ID);
  if (open && payload.trigger_id) {
    // Slack takes the trigger for about three seconds, so open the modal before anything else.
    const secret = parseRequest(open.value);
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    let view: Record<string, unknown>;
    if (!deps.admins.has(userId)) view = noticeModal("Not allowed", notAllowed(userId));
    else if (!secret || !channel)
      view = noticeModal("Can't set this", "This button no longer names a kiln repo.");
    else {
      const issue = secretNameIssue(secret.name);
      view = issue
        ? noticeModal("Can't set this", issue)
        : secretModal({
            ...secret,
            channel,
            thread: payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts,
          });
    }
    await deps.openView(payload.trigger_id, view);
    return new Response(null, { status: 200 });
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === MODAL_CALLBACK_ID) {
    const errors = (text: string) =>
      Response.json({ response_action: "errors", errors: { [INPUT_BLOCK_ID]: text } });
    if (!deps.admins.has(userId)) return errors(notAllowed(userId));
    let context: ModalContext;
    try {
      context = JSON.parse(payload.view.private_metadata ?? "") as ModalContext;
    } catch {
      return errors("This form is broken; ask for the secret again.");
    }
    const value = payload.view.state?.values?.[INPUT_BLOCK_ID]?.[INPUT_ACTION_ID]?.value?.trim() ?? "";
    try {
      await deps.setSecret(context.repo, context.name, value);
    } catch (error) {
      deps.log("secrets.set_failed", {
        repo: context.repo,
        name: context.name,
        user: userId,
        error: String(error),
      });
      return errors(error instanceof Error ? error.message : String(error));
    }
    deps.log("secrets.set", { repo: context.repo, name: context.name, user: userId });
    deps.waitUntil(
      deps
        .postMessage(
          context.channel,
          context.thread,
          `<@${userId}> set \`${context.name}\` for *${context.repo}*. New jobs on it get the new value.`,
        )
        .catch((error: unknown) => deps.log("secrets.notice_failed", { error: String(error) })),
    );
    return Response.json({ response_action: "clear" });
  }

  return deps.forward(body, request.headers);
}
