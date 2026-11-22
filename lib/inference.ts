// A deployment's own inference endpoint, Anthropic-compatible, from
// INFERENCE_BASE_URL and INFERENCE_API_KEY on the agent's Vercel project. When
// set, the agent's own model and every Claude Code job run on it; without it the
// agent falls back to AI Gateway and Claude jobs can't start. The key goes as x-api-key,
// as Anthropic's API and Claude Code send it.

export interface Inference {
  readonly baseURL: string;
  readonly apiKey: string;
}

/** The endpoint, undefined when unset, or why half of it is missing: never a silent fallback to AI Gateway. */
export function inferenceFrom(
  env: Readonly<Record<string, string | undefined>>,
): Inference | string | undefined {
  const baseURL = env.INFERENCE_BASE_URL?.trim();
  const apiKey = env.INFERENCE_API_KEY?.trim();
  if (!baseURL && !apiKey) return undefined;
  if (!baseURL) return "INFERENCE_API_KEY is set without INFERENCE_BASE_URL";
  if (!apiKey) return "INFERENCE_BASE_URL is set without INFERENCE_API_KEY";
  return { baseURL, apiKey };
}

/** The host part, without /v1: what Claude Code's ANTHROPIC_BASE_URL takes. Either form of the setting works. */
export function inferenceHost(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The Messages API root, with /v1: what the AI SDK's Anthropic provider takes. */
export function messagesRoot(baseURL: string): string {
  return `${inferenceHost(baseURL)}/v1`;
}
