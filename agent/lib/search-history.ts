// Keeps a conversation going when its earlier web searches can't be sent back.
//
// Anthropic's web search returns each result encrypted for the account that
// ran it, and every later turn sends those results back. When the turn lands on
// another account, such as when the inference router moves to its next
// credential because the first ran out, or after the agent moved off AI
// Gateway, the endpoint refuses the whole request ("Invalid `encrypted_content`
// in `search_result` block") on every try, and eve gives up on the thread. Here
// that one refusal is answered by sending the request again with each earlier
// search as plain text: what was searched, and each result's title and link.
// The model loses the pages' text from those old searches, not the thread.

/** The endpoint's refusal of a search result encrypted for another account. */
const FOREIGN_SEARCH_RESULT = /Invalid `encrypted_content` in `(?:web_)?search_result` block/;

type Block = Record<string, unknown>;
interface MessagesBody {
  messages?: { role?: string; content?: unknown }[];
}

const isBlock = (value: unknown): value is Block => typeof value === "object" && value !== null;

/** What a web search found, as text: the query, and each result's title and link. */
function searchAsText(query: string | undefined, content: unknown): string {
  const what = query ? `Web search for "${query}"` : "A web search";
  if (!Array.isArray(content)) return `${what} failed.`;
  const results = content
    .filter(isBlock)
    .map(
      (result) =>
        `- ${typeof result.title === "string" && result.title ? `${result.title}: ` : ""}${result.url}`,
    );
  return `${what}, from earlier in this conversation; only titles and links are kept:\n${results.join("\n") || "(no results)"}`;
}

/**
 * The request with each web search (its call and its encrypted results) replaced by a text block, and how
 * many were replaced. Everything else is left as it was.
 */
export function withSearchesAsText(body: MessagesBody): { body: MessagesBody; replaced: number } {
  const queries = new Map<string, string | undefined>();
  for (const message of body.messages ?? [])
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (
          isBlock(block) &&
          block.type === "server_tool_use" &&
          block.name === "web_search" &&
          typeof block.id === "string"
        )
          queries.set(
            block.id,
            isBlock(block.input) && typeof block.input.query === "string" ? block.input.query : undefined,
          );
  let replaced = 0;
  const messages = (body.messages ?? []).map((message) => {
    if (!Array.isArray(message.content)) return message;
    const content: unknown[] = [];
    for (const block of message.content) {
      if (
        isBlock(block) &&
        block.type === "server_tool_use" &&
        typeof block.id === "string" &&
        queries.has(block.id)
      )
        continue;
      if (isBlock(block) && block.type === "web_search_tool_result") {
        content.push({
          type: "text",
          text: searchAsText(queries.get(String(block.tool_use_id)), block.content),
        });
        replaced++;
        continue;
      }
      content.push(block);
    }
    return { ...message, content };
  });
  return { body: { ...body, messages }, replaced };
}

/**
 * A fetch for the Messages API that, when the endpoint refuses a request for a search result encrypted for
 * another account, sends it once more with the conversation's searches as text.
 */
export function searchSafeFetch(
  base: typeof globalThis.fetch,
  log: (event: string, fields?: Record<string, unknown>) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    const response = await base(input, init);
    if (response.status !== 400 || typeof init?.body !== "string") return response;
    if (!FOREIGN_SEARCH_RESULT.test(await response.clone().text())) return response;
    let rewritten: ReturnType<typeof withSearchesAsText>;
    try {
      rewritten = withSearchesAsText(JSON.parse(init.body) as MessagesBody);
    } catch {
      return response;
    }
    if (rewritten.replaced === 0) return response;
    log("model.searches_sent_as_text", { replaced: rewritten.replaced });
    return base(input, { ...init, body: JSON.stringify(rewritten.body) });
  };
}
