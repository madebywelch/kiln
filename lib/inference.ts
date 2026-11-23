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

/** The endpoint refused for a rate or usage limit: when it says it resets, and which model it named. */
export interface RateLimit {
  /** Milliseconds until the limit resets, when the error says. */
  readonly resetMs?: number;
  readonly model?: string;
}

const RATE_LIMITED = /\b429\b|rate[_ ]limit|cooling down/i;
const RESET = /reset (?:after|in) ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s)?)/i;
const RETRY_AFTER = /retry[- ]after:? (\d+(?:\.\d+)?) ?s/i;
const REFUSED_MODEL = /for model ([\w.-]+)/i;

/**
 * Reads a rate limit from an endpoint's error text, such as `Request rejected (429) · All credentials
 * for model claude-opus-5-5 are cooling down (reset after 1h32m14s)`. Null for any other error.
 */
export function rateLimitOf(text: string): RateLimit | null {
  if (!RATE_LIMITED.test(text)) return null;
  const reset = RESET.exec(text)?.[1];
  const retryAfter = RETRY_AFTER.exec(text)?.[1];
  let resetMs: number | undefined;
  if (reset) {
    const part = (unit: string) => Number(new RegExp(`(\\d+(?:\\.\\d+)?)${unit}`).exec(reset)?.[1] ?? 0);
    resetMs = Math.round(((part("h") * 60 + part("m")) * 60 + part("s")) * 1000) || undefined;
  } else if (retryAfter) {
    resetMs = Math.round(Number(retryAfter) * 1000) || undefined;
  }
  const model = REFUSED_MODEL.exec(text)?.[1];
  return { ...(resetMs ? { resetMs } : {}), ...(model ? { model } : {}) };
}

export type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly limit: RateLimit | null; readonly why: string };

/**
 * Asks the endpoint for one token, to see whether it is back. Only a rate limit (429), an outage (5xx),
 * or no answer counts as down: any other answer means it serves requests again.
 */
export async function probeInference(
  inference: Inference,
  model: string,
  fetchFn: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const response = await fetchFn(`${messagesRoot(inference.baseURL)}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": inference.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status !== 429 && response.status < 500) return { ok: true };
    const text = (await response.text()).slice(0, 2_000);
    const retryAfter = response.headers.get("retry-after");
    const said = `${response.status} ${text}${retryAfter ? ` retry-after: ${retryAfter}s` : ""}`;
    return { ok: false, limit: rateLimitOf(said), why: said.slice(0, 300) };
  } catch (error) {
    return { ok: false, limit: null, why: String(error).slice(0, 300) };
  }
}
