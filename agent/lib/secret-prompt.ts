// Collecting a repo secret in Slack without a model ever seeing it, and
// deleting or copying one to GitHub only when a person confirms it.
//
// The agent posts a "Set NAME" button (request_secret). A click opens a modal;
// its submission goes straight to boat, and what the secret is goes to kiln's
// labels. A "Delete NAME" button (delete_secret) asks Slack to confirm, then
// deletes. A "Copy to GitHub" button (copy_secrets_to_github) asks Slack to
// confirm, then copies values from boat into GitHub Actions secrets, and saving
// a secret again updates its copies. eve's Slack channel drops modal
// payloads it didn't create, so Slack's interactivity URL points at
// /slack/interactivity (agent/channels/slack-interactivity.ts): it handles the
// button and the modal here and forwards every other payload, byte for byte,
// to eve's Slack route.

import { createHmac, timingSafeEqual } from "node:crypto";
import { environmentName, SECRET_GROUPS, type SecretGroup, secretNameIssue } from "../../lib/secrets.ts";

export const OPEN_ACTION_ID = "kiln_secret_open";
export const DELETE_ACTION_ID = "kiln_secret_delete";
export const COPY_ACTION_ID = "kiln_secret_github";
export const MODAL_CALLBACK_ID = "kiln_secret";
const INPUT_BLOCK_ID = "secret";
const INPUT_ACTION_ID = "value";
const MAX_SIGNATURE_AGE_SECONDS = 300;

export interface SecretRequest {
  readonly repo: string;
  readonly group: SecretGroup;
  readonly name: string;
  /** What it is and what it reaches: shown above the button and kept as its label. */
  readonly description: string;
  /** The day it stops working, YYYY-MM-DD, when it has one. */
  readonly expires?: string;
  /** The job paused for this secret, which saving it may resume. */
  readonly job?: string;
}

/** A secret to delete, once a person confirms. */
export interface SecretDeletion {
  readonly repo: string;
  readonly group: SecretGroup;
  readonly name: string;
}

/** Secrets to copy from one group into GitHub Actions, once a person confirms. */
export interface GitHubCopyRequest {
  readonly repo: string;
  readonly group: SecretGroup;
  /** The GitHub repo, owner/name: one of the project's. */
  readonly github: string;
  /** A GitHub environment; without one, repository secrets. */
  readonly environment?: string;
  /** Each kiln name, and its name in GitHub. */
  readonly secrets: readonly { readonly name: string; readonly as: string }[];
}

/** What deleting a secret did, and the GitHub copies it left in place. */
export interface DeletionOutcome {
  readonly deleted: boolean;
  readonly github: readonly string[];
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

/** The message the agent posts to ask for a secret: what it is, and a button. */
export function requestBlocks(request: SecretRequest): Record<string, unknown>[] {
  const expires = request.expires ? ` Expires ${request.expires}.` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${request.repo}* needs \`${request.name}\` in its *${request.group}* secrets: ${request.description}${expires}`,
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
          text: `Stored in boat environment \`${environmentName(request.repo, request.group)}\`. Only ${request.repo} jobs started with its ${request.group} secrets see it, and the agent never does.`,
        },
      ],
    },
  ];
}

/** The message the agent posts to delete a secret: a button Slack makes the person confirm. */
export function deleteBlocks(deletion: SecretDeletion, why: string): Record<string, unknown>[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Delete \`${deletion.name}\` from *${deletion.repo}*'s *${deletion.group}* secrets? ${why}`.trim(),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: DELETE_ACTION_ID,
          text: { type: "plain_text", text: `Delete ${deletion.name}` },
          value: JSON.stringify(deletion),
          style: "danger",
          confirm: {
            title: { type: "plain_text", text: "Delete this secret?" },
            text: {
              type: "mrkdwn",
              text: `\`${deletion.name}\` goes from boat environment \`${environmentName(deletion.repo, deletion.group)}\` for good. Jobs that start after this won't have it.`,
            },
            confirm: { type: "plain_text", text: "Delete" },
            deny: { type: "plain_text", text: "Keep it" },
            style: "danger",
          },
        },
      ],
    },
  ];
}

const copyTarget = (copy: GitHubCopyRequest) =>
  copy.environment
    ? `*${copy.github}*'s *${copy.environment}* environment`
    : `*${copy.github}*'s repository secrets`;

const copyList = (copy: GitHubCopyRequest) =>
  copy.secrets.map(({ name, as }) => (name === as ? `\`${name}\`` : `\`${name}\` as \`${as}\``)).join(", ");

/** The message the agent posts to copy secrets into GitHub Actions: a button Slack makes the person confirm. */
export function copyBlocks(copy: GitHubCopyRequest, why: string): Record<string, unknown>[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `Copy ${copyList(copy)} from *${copy.repo}*'s *${copy.group}* secrets to ${copyTarget(copy)}? ${why}`.trim(),
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: COPY_ACTION_ID,
          text: { type: "plain_text", text: "Copy to GitHub" },
          value: JSON.stringify(copy),
          style: copy.group === "staging" ? "primary" : "danger",
          confirm: {
            title: { type: "plain_text", text: "Copy to GitHub?" },
            text: {
              type: "mrkdwn",
              text: `Every workflow that can use ${copy.environment ? `the ${copy.environment} environment` : "this repo's secrets"} in ${copy.github} gets these values. Saving one of them again in kiln updates its copy.`,
            },
            confirm: { type: "plain_text", text: "Copy" },
            deny: { type: "plain_text", text: "Don't" },
          },
        },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "The values go from boat to GitHub, sealed with the repo's key; the agent never sees them.",
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
          text: `\`${context.name}\` for *${context.repo}*'s *${context.group}* secrets: ${context.description} Saved to boat environment \`${environmentName(context.repo, context.group)}\`; jobs started with these secrets get it as an environment variable. Setting it again replaces it.`,
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
  /** Whether a repo is one this deployment works on. */
  readonly isRepo: (repo: string) => boolean;
  readonly signingSecret: string | undefined;
  /** Whether a Slack user may set secrets. */
  readonly mayEdit: (userId: string) => boolean;
  readonly openView: (triggerId: string, view: Record<string, unknown>) => Promise<unknown>;
  /** Saves the value, then records what the secret is and who saved it. */
  readonly setSecret: (request: SecretRequest, value: string, savedBy: string) => Promise<void>;
  /** Deletes a secret and its label. */
  readonly deleteSecret: (deletion: SecretDeletion) => Promise<DeletionOutcome>;
  /** Copies secrets into GitHub and records the copies; says what happened, in a sentence for the thread. */
  readonly copyToGitHub: (copy: GitHubCopyRequest) => Promise<string>;
  /**
   * After a secret is saved: updates its GitHub copies with the value in hand, and says what happened in a
   * sentence for the thread; undefined when it has none.
   */
  readonly updateGitHubCopies: (request: SecretRequest, value: string) => Promise<string | undefined>;
  readonly postMessage: (channel: string, thread: string | undefined, text: string) => Promise<unknown>;
  /**
   * After a secret is saved for a paused job: resumes the job if nothing else is missing, and says what
   * happened in a sentence for the thread.
   */
  readonly resumeJob: (job: string, repo: string, group: SecretGroup) => Promise<string | undefined>;
  /** Hands a payload that isn't kiln's to eve's Slack route. */
  readonly forward: (body: string, headers: Headers) => Promise<Response>;
  readonly waitUntil: (work: Promise<unknown>) => void;
  readonly log: (event: string, fields?: Record<string, unknown>) => void;
  readonly nowSeconds?: () => number;
}

/**
 * Who may set secrets, from KILN_SECRET_ADMINS: a comma-separated list of Slack user IDs. Unset, anyone
 * in the workspace may, which suits a workspace of one; set it once anyone else can talk to the agent.
 */
export function secretEditors(value: string | undefined): (userId: string) => boolean {
  const ids = new Set(
    (value ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  return (userId) => ids.size === 0 || ids.has(userId);
}

const notAllowed = (userId: string) =>
  `Only the people in \`KILN_SECRET_ADMINS\` can set repo secrets. Ask an operator to add your Slack user ID, \`${userId}\`.`;

const isGroup = (value: unknown): value is SecretGroup =>
  typeof value === "string" && (SECRET_GROUPS as readonly string[]).includes(value);

function parseRequest(value: unknown, isRepo: (repo: string) => boolean): SecretRequest | null {
  try {
    const parsed = JSON.parse(String(value)) as Partial<SecretRequest>;
    if (
      typeof parsed.repo === "string" &&
      typeof parsed.name === "string" &&
      isGroup(parsed.group) &&
      isRepo(parsed.repo)
    ) {
      return {
        repo: parsed.repo,
        group: parsed.group,
        name: parsed.name,
        description: typeof parsed.description === "string" ? parsed.description : "",
        ...(typeof parsed.expires === "string" && parsed.expires ? { expires: parsed.expires } : {}),
        ...(typeof parsed.job === "string" && parsed.job ? { job: parsed.job } : {}),
      };
    }
  } catch {
    // not ours
  }
  return null;
}

function parseDeletion(value: unknown, isRepo: (repo: string) => boolean): SecretDeletion | null {
  try {
    const parsed = JSON.parse(String(value)) as Partial<SecretDeletion>;
    if (
      typeof parsed.repo === "string" &&
      typeof parsed.name === "string" &&
      isGroup(parsed.group) &&
      isRepo(parsed.repo)
    )
      return { repo: parsed.repo, group: parsed.group, name: parsed.name };
  } catch {
    // not ours
  }
  return null;
}

function parseCopy(value: unknown, isRepo: (repo: string) => boolean): GitHubCopyRequest | null {
  try {
    const parsed = JSON.parse(String(value)) as Partial<GitHubCopyRequest>;
    if (
      typeof parsed.repo === "string" &&
      isGroup(parsed.group) &&
      isRepo(parsed.repo) &&
      typeof parsed.github === "string" &&
      Array.isArray(parsed.secrets) &&
      parsed.secrets.length > 0 &&
      parsed.secrets.every((s) => typeof s?.name === "string" && typeof s?.as === "string")
    )
      return {
        repo: parsed.repo,
        group: parsed.group,
        github: parsed.github,
        ...(typeof parsed.environment === "string" && parsed.environment
          ? { environment: parsed.environment }
          : {}),
        secrets: parsed.secrets.map(({ name, as }) => ({ name, as })),
      };
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
    const secret = parseRequest(open.value, deps.isRepo);
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    let view: Record<string, unknown>;
    if (!deps.mayEdit(userId)) view = noticeModal("Not allowed", notAllowed(userId));
    else if (!secret || !channel)
      view = noticeModal("Can't set this", "This button no longer names a kiln repo.");
    else {
      const issue = secretNameIssue(secret.name, secret.group);
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

  const remove =
    payload.type === "block_actions" && payload.actions?.find((a) => a.action_id === DELETE_ACTION_ID);
  if (remove) {
    // Slack asked the person to confirm before sending this.
    const deletion = parseDeletion(remove.value, deps.isRepo);
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const thread = payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts;
    if (!deletion || !channel) return new Response(null, { status: 200 });
    deps.waitUntil(
      (async () => {
        let text: string;
        if (!deps.mayEdit(userId)) text = notAllowed(userId);
        else {
          const { deleted, github } = await deps.deleteSecret(deletion);
          deps.log("secrets.deleted", { ...deletion, user: userId, existed: deleted });
          text = deleted
            ? `<@${userId}> deleted \`${deletion.name}\` from *${deletion.repo}*'s *${deletion.group}* secrets. Jobs that start now don't have it.`
            : `\`${deletion.name}\` wasn't in *${deletion.repo}*'s *${deletion.group}* secrets; nothing to delete.`;
          if (github.length > 0)
            text += ` Its GitHub copies stay until they're deleted there: ${github.join("; ")}.`;
        }
        await deps.postMessage(channel, thread, text);
      })().catch((error: unknown) =>
        deps.log("secrets.delete_failed", { ...deletion, error: String(error) }),
      ),
    );
    return new Response(null, { status: 200 });
  }

  const copy =
    payload.type === "block_actions" && payload.actions?.find((a) => a.action_id === COPY_ACTION_ID);
  if (copy) {
    // Slack asked the person to confirm before sending this.
    const request = parseCopy(copy.value, deps.isRepo);
    const channel = payload.channel?.id ?? payload.container?.channel_id;
    const thread = payload.message?.thread_ts ?? payload.container?.thread_ts ?? payload.message?.ts;
    if (!request || !channel) return new Response(null, { status: 200 });
    deps.waitUntil(
      (async () => {
        let text: string;
        if (!deps.mayEdit(userId)) text = notAllowed(userId);
        else {
          const outcome = await deps.copyToGitHub(request);
          deps.log("secrets.github_copied", {
            repo: request.repo,
            group: request.group,
            github: request.github,
            environment: request.environment ?? null,
            names: request.secrets.map((s) => s.name),
            user: userId,
          });
          text = `<@${userId}> ${outcome}`;
        }
        await deps.postMessage(channel, thread, text);
      })().catch((error: unknown) =>
        deps.log("secrets.github_copy_failed", {
          repo: request.repo,
          github: request.github,
          error: String(error),
        }),
      ),
    );
    return new Response(null, { status: 200 });
  }

  if (payload.type === "view_submission" && payload.view?.callback_id === MODAL_CALLBACK_ID) {
    const errors = (text: string) =>
      Response.json({ response_action: "errors", errors: { [INPUT_BLOCK_ID]: text } });
    if (!deps.mayEdit(userId)) return errors(notAllowed(userId));
    let context: ModalContext;
    try {
      context = JSON.parse(payload.view.private_metadata ?? "") as ModalContext;
    } catch {
      return errors("This form is broken; ask for the secret again.");
    }
    const value = payload.view.state?.values?.[INPUT_BLOCK_ID]?.[INPUT_ACTION_ID]?.value?.trim() ?? "";
    try {
      const { channel: _channel, thread: _thread, ...request } = context;
      await deps.setSecret(request, value, userId);
    } catch (error) {
      deps.log("secrets.set_failed", {
        repo: context.repo,
        group: context.group,
        name: context.name,
        user: userId,
        error: String(error),
      });
      return errors(error instanceof Error ? error.message : String(error));
    }
    deps.log("secrets.set", {
      repo: context.repo,
      group: context.group,
      name: context.name,
      user: userId,
      job: context.job ?? null,
    });
    const { channel: _channel, thread: _thread, ...saved } = context;
    deps.waitUntil(
      (async () => {
        let github: string | undefined;
        try {
          github = await deps.updateGitHubCopies(saved, value);
        } catch (error) {
          deps.log("secrets.github_update_failed", {
            repo: context.repo,
            name: context.name,
            error: String(error),
          });
          github = "Its GitHub copies weren't updated; ask me to check them.";
        }
        let next = `Jobs started with its ${context.group} secrets get the new value.`;
        if (context.job) {
          try {
            next = (await deps.resumeJob(context.job, context.repo, context.group)) ?? next;
          } catch (error) {
            deps.log("secrets.resume_failed", { job: context.job, error: String(error) });
            next = `Job #${context.job} didn't resume; ask me to check it.`;
          }
        }
        await deps.postMessage(
          context.channel,
          context.thread,
          `<@${userId}> set \`${context.name}\` in *${context.repo}*'s *${context.group}* secrets. ${next}${github ? ` ${github}` : ""}`,
        );
      })().catch((error: unknown) => deps.log("secrets.notice_failed", { error: String(error) })),
    );
    return Response.json({ response_action: "clear" });
  }

  return deps.forward(body, request.headers);
}
