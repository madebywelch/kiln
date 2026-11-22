import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { inferenceModel } from "../agent/lib/inference.ts";
import { inferenceFrom, inferenceHost, messagesRoot } from "../lib/inference.ts";

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
