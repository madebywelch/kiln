import { anthropic } from "@ai-sdk/anthropic";
import { generateText, type ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { inferenceModel } from "../agent/lib/inference.ts";
import { searchSafeFetch, withSearchesAsText } from "../agent/lib/search-history.ts";

const REFUSAL = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message: "messages.1.content.0: Invalid `encrypted_content` in `search_result` block",
  },
};
const reply = (text: string) =>
  Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-fable-5-2",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  });

/** An endpoint on another account than the one that ran the search: it refuses any encrypted result. */
function otherAccount() {
  const bodies: string[] = [];
  const fetch: typeof globalThis.fetch = async (_input, init) => {
    const body = String(init?.body);
    bodies.push(body);
    return body.includes("encrypted_content") ? Response.json(REFUSAL, { status: 400 }) : reply("still here");
  };
  return { fetch, bodies };
}

const searched: ModelMessage[] = [
  { role: "user", content: "What's new in eve?" },
  {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: "srvtoolu_1",
        toolName: "web_search",
        input: { query: "eve 1.3 release" },
        providerExecuted: true,
      },
      {
        type: "tool-result",
        toolCallId: "srvtoolu_1",
        toolName: "web_search",
        output: {
          type: "json",
          value: [
            {
              type: "web_search_result",
              url: "https://example.com/eve-1-3",
              title: "eve 1.3",
              pageAge: null,
              encryptedContent: "EncFromAccountA",
            },
          ],
        },
      },
      { type: "text", text: "eve 1.3 added dynamic schedules." },
    ],
  },
  { role: "user", content: "And before that?" },
];

describe("earlier web searches encrypted for another account", () => {
  it("keeps the thread going: the turn is sent again with the search as its query, titles, and links", async () => {
    const endpoint = otherAccount();
    const { text } = await generateText({
      model: inferenceModel({ baseURL: "https://llm.example.com", apiKey: "sk" }, undefined, endpoint.fetch),
      tools: { web_search: anthropic.tools.webSearch_20250305() },
      messages: searched,
    });
    expect(text).toBe("still here");
    expect(endpoint.bodies).toHaveLength(2);
    expect(endpoint.bodies[0]).toContain("EncFromAccountA");
    const retried = JSON.parse(endpoint.bodies[1] ?? "{}");
    expect(JSON.stringify(retried)).not.toContain("EncFromAccountA");
    expect(retried.messages[1].content).toEqual([
      {
        type: "text",
        text: 'Web search for "eve 1.3 release", from earlier in this conversation; only titles and links are kept:\n- eve 1.3: https://example.com/eve-1-3',
      },
      expect.objectContaining({ type: "text", text: "eve 1.3 added dynamic schedules." }),
    ]);
  });

  it("passes every other refusal through untouched, without a second request", async () => {
    let calls = 0;
    const fetch = searchSafeFetch(
      async () => {
        calls++;
        return Response.json({ type: "error", error: { message: "prompt is too long" } }, { status: 400 });
      },
      () => undefined,
    );
    const response = await fetch("https://llm.example.com/v1/messages", { method: "POST", body: "{}" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ type: "error", error: { message: "prompt is too long" } });
    expect(calls).toBe(1);
  });

  it("gives back the refusal when there's no search to rewrite, and logs each rewrite", async () => {
    const events: unknown[] = [];
    let calls = 0;
    const fetch = searchSafeFetch(
      async () => {
        calls++;
        return Response.json(REFUSAL, { status: 400 });
      },
      (event, fields) => events.push({ event, ...fields }),
    );
    const response = await fetch("https://x/v1/messages", {
      method: "POST",
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
    expect(events).toEqual([]);
  });

  it("writes a failed search as having failed, and leaves other tools' blocks alone", () => {
    const { body, replaced } = withSearchesAsText({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "server_tool_use", id: "s1", name: "web_search", input: { query: "q" } },
            {
              type: "web_search_tool_result",
              tool_use_id: "s1",
              content: { type: "web_search_tool_result_error", error_code: "unavailable" },
            },
            { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://a" } },
          ],
        },
      ],
    });
    expect(replaced).toBe(1);
    expect(body.messages?.[0]?.content).toEqual([
      { type: "text", text: 'Web search for "q" failed.' },
      { type: "server_tool_use", id: "f1", name: "web_fetch", input: { url: "https://a" } },
    ]);
  });
});
