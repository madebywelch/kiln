import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";
import { inferenceFrom } from "../lib/inference.ts";
import { inferenceModel } from "./lib/inference.ts";

// The agent's own model, for conversation and judgment. The coding work runs on
// the workers' subscriptions, chosen per job, not on this model. One of three
// routes, picked by which settings are present:
//
// - INFERENCE_BASE_URL and INFERENCE_API_KEY: the deployment's Anthropic-compatible
//   endpoint (lib/inference.ts), with KILN_MODEL as its model ID (default
//   claude-fable-5-2). Workers' Claude Code jobs use it too.
// - KILN_MODEL_URL and KILN_MODEL_KEY: an OpenAI-compatible endpoint (OpenRouter,
//   a local server), with KILN_MODEL as its model name.
// - Neither: AI Gateway, with KILN_MODEL as a Gateway model ID.
//
// KILN_REASONING sets the reasoning level on every route.
const DEFAULT_MODEL = "anthropic/claude-fable-5.2";
const REASONING = ["provider-default", "none", "minimal", "low", "medium", "high", "xhigh"] as const;
const DEFAULT_REASONING: (typeof REASONING)[number] = "high";
const CUSTOM_CONTEXT_WINDOW = 200_000;

function reasoning(): (typeof REASONING)[number] {
  const value = process.env.KILN_REASONING;
  if (!value) return DEFAULT_REASONING;
  if ((REASONING as readonly string[]).includes(value)) return value as (typeof REASONING)[number];
  console.error(JSON.stringify({ event: "agent.reasoning_invalid", value, using: DEFAULT_REASONING }));
  return DEFAULT_REASONING;
}

export default defineAgent({
  model: defineDynamic(() => {
    const inference = inferenceFrom(process.env);
    // Half a setting fails the turn, rather than quietly spending on AI Gateway.
    if (typeof inference === "string") throw new Error(`${inference} on the agent's Vercel project`);
    if (inference) {
      return {
        model: inferenceModel(inference, process.env.KILN_MODEL),
        reasoning: reasoning(),
        modelContextWindowTokens: CUSTOM_CONTEXT_WINDOW,
      };
    }
    const id = process.env.KILN_MODEL || DEFAULT_MODEL;
    const url = process.env.KILN_MODEL_URL;
    if (!url) return { model: id, reasoning: reasoning() };
    const provider = createOpenAICompatible({
      name: "kiln",
      baseURL: url,
      apiKey: process.env.KILN_MODEL_KEY,
      includeUsage: true,
    });
    return { model: provider(id), modelContextWindowTokens: CUSTOM_CONTEXT_WINDOW };
  }),
});
