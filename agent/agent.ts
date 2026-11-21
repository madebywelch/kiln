import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

// The agent's own model, for conversation and judgment. The coding work runs on
// the workers' subscriptions, chosen per job, not on this model.
//
// KILN_MODEL is an AI Gateway model ID by default. Set KILN_MODEL_URL to
// use any OpenAI-compatible endpoint instead (OpenRouter, a local server),
// with KILN_MODEL_KEY as its key and KILN_MODEL as its model name.
const DEFAULT_MODEL = "anthropic/claude-opus-5.5";
const CUSTOM_CONTEXT_WINDOW = 200_000;

export default defineAgent({
  model: defineDynamic(() => {
    const id = process.env.KILN_MODEL || DEFAULT_MODEL;
    const url = process.env.KILN_MODEL_URL;
    if (!url) return { model: id, reasoning: "medium" };
    const provider = createOpenAICompatible({
      name: "kiln",
      baseURL: url,
      apiKey: process.env.KILN_MODEL_KEY,
      includeUsage: true,
    });
    return { model: provider(id), modelContextWindowTokens: CUSTOM_CONTEXT_WINDOW };
  }),
});
