import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defineAgent } from "eve";
import { defineDynamic } from "eve/models";

// robdog's own model, for conversation and judgment. The coding work runs on
// the workers' subscriptions, chosen per job, not on this model.
//
// ROBDOG_MODEL is an AI Gateway model ID by default. Set ROBDOG_MODEL_URL to
// use any OpenAI-compatible endpoint instead (OpenRouter, a local server),
// with ROBDOG_MODEL_KEY as its key and ROBDOG_MODEL as its model name.
const DEFAULT_MODEL = "anthropic/claude-opus-5.5";
const CUSTOM_CONTEXT_WINDOW = 200_000;

export default defineAgent({
  model: defineDynamic(() => {
    const id = process.env.ROBDOG_MODEL || DEFAULT_MODEL;
    const url = process.env.ROBDOG_MODEL_URL;
    if (!url) return { model: id, reasoning: "medium" };
    const provider = createOpenAICompatible({
      name: "robdog",
      baseURL: url,
      apiKey: process.env.ROBDOG_MODEL_KEY,
      includeUsage: true,
    });
    return { model: provider(id), modelContextWindowTokens: CUSTOM_CONTEXT_WINDOW };
  }),
});
