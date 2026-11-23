import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { inferenceModel } from "../agent/lib/inference.ts";
import { inferenceFrom, inferenceHost, messagesRoot, probeInference, rateLimitOf } from "../lib/inference.ts";

describe("the inference endpoint", () => {
  it("is off when unset, and refuses half a setting instead of falling back to AI Gateway", () => {
    expect(inferenceFrom({})).toBeUndefined();
    expect(inferenceFrom({ INFERENCE_BASE_URL: "https://llm.example.com" })).toMatch(
      /without INFERENCE_API_KEY/,
    );
    expect(inferenceFrom({ INFERENCE_API_KEY: "sk" })).toMatch(/without INFERENCE_BASE_URL/);
    expect(
      inferenceFrom({ INFERENCE_BASE_URL: " https://llm.example.com ", INFERENCE_API_KEY: "sk " }),
    ).toEqual({
      baseURL: "https://llm.example.com",
      apiKey: "sk",
    });
  });

  it("takes the base URL with or without /v1: Claude Code gets the host, the AI SDK the /v1 root", () => {
    for (const url of [
      "https://llm.example.com",
      "https://llm.example.com/",
      "https://llm.example.com/v1/",
    ]) {
      expect(inferenceHost(url)).toBe("https://llm.example.com");
      expect(messagesRoot(url)).toBe("https://llm.example.com/v1");
    }
    expect(messagesRoot("https://gw.example.com/anthropic")).toBe("https://gw.example.com/anthropic/v1");
  });

  it("serves the agent's model: <host>/v1/messages, the key as x-api-key, Fable 5.2 unless KILN_MODEL says otherwise", async () => {
    const seen: { url: string; key: string | null; model: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(input), key: new Headers(init?.headers).get("x-api-key"), model: body.model });
      return Response.json({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text: "pong" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    };
    const endpoint = { baseURL: "https://llm.example.com", apiKey: "sk-test" };
    const { text } = await generateText({
      model: inferenceModel(endpoint, undefined, fetch),
      prompt: "ping",
    });
    expect(text).toBe("pong");
    await generateText({ model: inferenceModel(endpoint, "claude-opus-5-5", fetch), prompt: "ping" });
    expect(seen).toEqual([
      { url: "https://llm.example.com/v1/messages", key: "sk-test", model: "claude-fable-5-2" },
      { url: "https://llm.example.com/v1/messages", key: "sk-test", model: "claude-opus-5-5" },
    ]);
  });
});

describe("rate limits", () => {
  it("reads when the endpoint's limit resets and which model it refused", () => {
    expect(
      rateLimitOf(
        "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down via provider claude (last error: rate_limit_error: ...) (reset after 1h32m14s)",
      ),
    ).toEqual({ resetMs: 5_534_000, model: "claude-opus-5-5" });
    expect(rateLimitOf("429 Too Many Requests retry-after: 30s")).toEqual({ resetMs: 30_000 });
    expect(rateLimitOf("rate_limit_error: slow down")).toEqual({});
    expect(rateLimitOf("401 Failed to authenticate")).toBeNull();
    expect(rateLimitOf("400 model not found")).toBeNull();
  });

  it("counts only a rate limit, an outage, or silence as the endpoint still being down", async () => {
    const endpoint = { baseURL: "https://llm.example.com/v1", apiKey: "sk-endpoint" };
    const seen: { url: string; key: string | null; body: unknown }[] = [];
    const answering =
      (status: number, body = "", headers: Record<string, string> = {}): typeof fetch =>
      async (input, init) => {
        seen.push({
          url: String(input),
          key: new Headers(init?.headers).get("x-api-key"),
          body: JSON.parse(String(init?.body)),
        });
        return new Response(body, { status, headers });
      };
    expect(await probeInference(endpoint, "claude-opus-5-5", answering(200, "{}"))).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      url: "https://llm.example.com/v1/messages",
      key: "sk-endpoint",
      body: { model: "claude-opus-5-5", max_tokens: 1, messages: [{ role: "user", content: "ping" }] },
    });
    // Any other answer means it serves requests, even one it refuses for another reason.
    expect(await probeInference(endpoint, "nope", answering(400, "model not found"))).toEqual({ ok: true });
    expect(
      await probeInference(endpoint, "claude-opus-5-5", answering(429, "cooling down (reset after 20m)")),
    ).toMatchObject({ ok: false, limit: { resetMs: 1_200_000 } });
    expect(
      await probeInference(endpoint, "m", answering(429, "slow down", { "retry-after": "90" })),
    ).toMatchObject({
      ok: false,
      limit: { resetMs: 90_000 },
    });
    expect(await probeInference(endpoint, "m", answering(503, "overloaded"))).toMatchObject({
      ok: false,
      limit: null,
    });
    const silent: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await probeInference(endpoint, "m", silent)).toMatchObject({ ok: false, limit: null });
  });
});
