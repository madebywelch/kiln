// The agent's own model on the deployment's inference endpoint (lib/inference.ts).

import { createAnthropic } from "@ai-sdk/anthropic";
import { type Inference, messagesRoot } from "../../lib/inference.ts";
import { searchSafeFetch } from "./search-history.ts";

const log = (event: string, fields: Record<string, unknown> = {}) =>
  console.info(JSON.stringify({ event, ...fields }));

export const DEFAULT_INFERENCE_MODEL = "claude-fable-5-2";

/**
 * The model on the endpoint: KILN_MODEL as its model ID, Fable 5.2 by default. Earlier web searches the
 * endpoint can't take back, being encrypted for another account, are sent again as text (search-history.ts).
 */
export function inferenceModel(inference: Inference, model?: string, fetch?: typeof globalThis.fetch) {
  const provider = createAnthropic({
    baseURL: messagesRoot(inference.baseURL),
    apiKey: inference.apiKey,
    fetch: searchSafeFetch(fetch ?? globalThis.fetch, log),
  });
  return provider(model || DEFAULT_INFERENCE_MODEL);
}
