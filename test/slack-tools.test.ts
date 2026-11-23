import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversationContext, conversationLabel, markdownToMrkdwn } from "../agent/lib/slack.ts";
import slackHistory from "../agent/tools/slack_history.ts";
import slackPost from "../agent/tools/slack_post.ts";
import slackReact from "../agent/tools/slack_react.ts";
import slackUpload from "../agent/tools/slack_upload.ts";

// A fake Slack Web API behind global fetch: records each call and answers from `replies`.
interface Call {
  method: string;
  body: Record<string, string>;
  raw: unknown;
}
let calls: Call[];
let replies: Record<string, (body: Record<string, string>) => Record<string, unknown>>;

function parseBody(init?: RequestInit): Record<string, string> {
  const body = init?.body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return Object.fromEntries(new URLSearchParams(body));
    }
  }
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  return {};
}

beforeEach(() => {
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  calls = [];
  replies = {};
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "files.example") {
      calls.push({ method: "upload", body: {}, raw: init?.body });
      return new Response("OK", { status: 200 });
    }
    const method = url.pathname.replace(/^\/api\//, "");
    const body = parseBody(init);
    calls.push({ method, body, raw: init?.body });
    const reply = replies[method]?.(body) ?? { ok: true };
    return Response.json(reply);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The tool context eve hands a tool in a Slack thread session.
const ctx = {
  channel: { kind: "slack", metadata: { channelId: "C0123", threadTs: "1700000000.000100", teamId: "T1" } },
} as never;
const offSlack = { channel: { kind: "eve", metadata: {} } } as never;

type Executable = { execute: (input: never, ctx: never) => unknown };
const run = (tool: unknown, input: unknown, context: never = ctx) =>
  Promise.resolve((tool as Executable).execute(input as never, context));

describe("slack_react", () => {
  it("reacts in the current channel and strips colons", async () => {
    await run(slackReact, { emoji: ":eyes:", message_ts: "1700000000.000200" });
    expect(calls).toEqual([
      expect.objectContaining({
        method: "reactions.add",
        body: expect.objectContaining({ channel: "C0123", timestamp: "1700000000.000200", name: "eyes" }),
      }),
    ]);
  });

  it("treats an existing reaction as done and surfaces other errors", async () => {
    replies["reactions.add"] = () => ({ ok: false, error: "already_reacted" });
    await expect(run(slackReact, { emoji: "eyes", message_ts: "1" })).resolves.toEqual({ reacted: "eyes" });
    replies["reactions.add"] = () => ({ ok: false, error: "invalid_name" });
    await expect(run(slackReact, { emoji: "nope", message_ts: "1" })).rejects.toThrow(/invalid_name/);
  });

  it("needs a channel outside Slack", async () => {
    await expect(run(slackReact, { emoji: "eyes", message_ts: "1" }, offSlack)).rejects.toThrow(/channel_id/);
  });
});

describe("slack_post", () => {
  it("posts top-level in the channel as markdown and ends the turn by default", async () => {
    replies["chat.postMessage"] = () => ({ ok: true, ts: "1700000000.000300" });
    const out = await run(slackPost, { text: "**Shipped.**", final: true });
    expect(out).toEqual({ channel: "C0123", ts: "1700000000.000300", endsTurn: true });
    const body = calls[0]?.body ?? {};
    expect(body.thread_ts).toBeUndefined();
    expect(JSON.parse(String(body.blocks))).toEqual([{ type: "markdown", text: "**Shipped.**" }]);
    expect((slackPost as unknown as { endsTurn: (o: unknown) => boolean }).endsTurn(out)).toBe(true);
  });

  it("posts into a thread and can keep the turn going", async () => {
    replies["chat.postMessage"] = () => ({ ok: true, ts: "2" });
    const out = await run(slackPost, { text: "hi", thread_ts: "1700000000.000100", final: false });
    expect(calls[0]?.body.thread_ts).toBe("1700000000.000100");
    expect(out).toMatchObject({ endsTurn: false });
  });

  it("falls back to plain text when Slack refuses the blocks", async () => {
    let attempts = 0;
    replies["chat.postMessage"] = (body) =>
      ++attempts === 1 && body.blocks ? { ok: false, error: "invalid_blocks" } : { ok: true, ts: "3" };
    await run(slackPost, { text: "table", blocks: [{ type: "bogus" }], final: true });
    expect(calls.map((call) => call.method)).toEqual(["chat.postMessage", "chat.postMessage"]);
    expect(calls[1]?.body.blocks).toBeUndefined();
  });
});

describe("slack_upload", () => {
  it("uploads text into the current thread in three steps", async () => {
    replies["files.getUploadURLExternal"] = () => ({
      ok: true,
      upload_url: "https://files.example/u",
      file_id: "F1",
    });
    const out = await run(slackUpload, { filename: "plan.md", content: "# Plan\n", comment: "Here it is" });
    expect(calls.map((call) => call.method)).toEqual([
      "files.getUploadURLExternal",
      "upload",
      "files.completeUploadExternal",
    ]);
    expect(calls[0]?.body).toMatchObject({ filename: "plan.md", length: "7" });
    expect(calls[2]?.body).toMatchObject({
      channel_id: "C0123",
      thread_ts: "1700000000.000100",
    });
    // Markdown, as the agent writes everywhere, in a block Slack renders.
    expect(JSON.parse(String(calls[2]?.body.blocks))).toEqual([{ type: "markdown", text: "Here it is" }]);
    expect(calls[2]?.body).not.toHaveProperty("initial_comment");
    expect(JSON.parse(String(calls[2]?.body.files))).toEqual([{ id: "F1", title: "plan.md" }]);
    expect(out).toMatchObject({ uploaded: "plan.md", bytes: 7 });
  });

  it("falls back to the comment in Slack's mrkdwn when Slack won't take blocks with a file", async () => {
    replies["files.getUploadURLExternal"] = () => ({
      ok: true,
      upload_url: "https://files.example/u",
      file_id: "F1",
    });
    replies["files.completeUploadExternal"] = (body) =>
      body.blocks ? { ok: false, error: "invalid_blocks" } : { ok: true };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await run(slackUpload, {
      filename: "a.png",
      content: "x",
      comment: "**Approve?** See [the PR](https://x.test/1)",
    });
    expect(calls.filter((call) => call.method === "files.completeUploadExternal")).toHaveLength(2);
    expect(calls.at(-1)?.body).toMatchObject({ initial_comment: "*Approve?* See <https://x.test/1|the PR>" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("slack.upload_blocks_refused"));
    warn.mockRestore();
  });

  it("does not retry a share Slack refused for another reason", async () => {
    replies["files.getUploadURLExternal"] = () => ({
      ok: true,
      upload_url: "https://files.example/u",
      file_id: "F1",
    });
    replies["files.completeUploadExternal"] = () => ({ ok: false, error: "not_in_channel" });
    await expect(run(slackUpload, { filename: "a.png", content: "x", comment: "hi" })).rejects.toThrow(
      /not_in_channel/,
    );
    expect(calls.filter((call) => call.method === "files.completeUploadExternal")).toHaveLength(1);
  });

  it("refuses an empty file before calling Slack", async () => {
    await expect(run(slackUpload, { filename: "x.txt", content: "" })).rejects.toThrow(/empty/);
    expect(calls).toEqual([]);
  });
});

describe("markdownToMrkdwn", () => {
  it("turns the agent's Markdown into Slack's mrkdwn", () => {
    expect(
      markdownToMrkdwn("## Ready\n**Bold** and ~~gone~~, [docs](https://x.test/d)\n- one\n  * two"),
    ).toBe("*Ready*\n*Bold* and ~gone~, <https://x.test/d|docs>\n• one\n  • two");
  });
});

describe("slack_history", () => {
  it("reads a thread oldest first, with names", async () => {
    replies["conversations.replies"] = () => ({
      ok: true,
      messages: [
        { ts: "1700000000.000300", user: "U2", text: "second", thread_ts: "1700000000.000100" },
        { ts: "1700000000.000100", user: "U1", text: "first", thread_ts: "1700000000.000100" },
        { ts: "1700000000.000200", subtype: "channel_join", user: "U3", text: "joined" },
      ],
    });
    replies["users.info"] = (body) => ({
      ok: true,
      user: { profile: { display_name: body.user === "U1" ? "ada" : "bob" } },
    });
    const out = (await run(slackHistory, { thread_ts: "1700000000.000100", limit: 30 })) as {
      messages: { from: string; text: string }[];
    };
    expect(out.messages.map((m) => [m.from, m.text])).toEqual([
      ["ada <@U1>", "first"],
      ["bob <@U2>", "second"],
    ]);
  });
});

describe("conversationContext", () => {
  it("names a channel once per process, and says a DM is a DM", async () => {
    replies["conversations.info"] = (body) =>
      body.channel === "D1"
        ? { ok: true, channel: { id: "D1", is_im: true } }
        : { ok: true, channel: { id: body.channel, name: "guaca" } };
    expect(await conversationContext("C_GUACA", "T1")).toBe(
      "This conversation is in the Slack channel #guaca.",
    );
    expect(await conversationContext("C_GUACA", "T1")).toBe(
      "This conversation is in the Slack channel #guaca.",
    );
    expect(await conversationContext("D1", "T1")).toBe("This conversation is in a direct message.");
    expect(calls.filter((call) => call.method === "conversations.info")).toHaveLength(2);
  });

  it("gives no context, rather than failing the message, when Slack refuses or names nothing", async () => {
    replies["conversations.info"] = () => ({ ok: false, error: "missing_scope" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await conversationContext("C_SECRET", "T1")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"error":"missing_scope"'));
    warn.mockRestore();
    replies["conversations.info"] = () => ({ ok: true, channel: {} });
    expect(await conversationContext("C_NAMELESS", "T1")).toBeUndefined();
    expect(conversationLabel({ is_mpim: true, name: "mpdm-a--b" })).toBe("a group direct message");
  });
});
