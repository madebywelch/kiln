import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

// The agent's own model, for conversation and judgment. The coding work runs on
// the workers' subscriptions, chosen per job, not on this model.
//
// KILN_MODEL is an AI Gateway model ID, and KILN_REASONING its reasoning level.
// Set KILN_MODEL_URL to use any OpenAI-compatible endpoint instead (OpenRouter,
// a local server), with KILN_MODEL_KEY as its key and KILN_MODEL as its model name.
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
