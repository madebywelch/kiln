// Read-only access to a repo through GitHub's API, so the agent can look at a
// repo in seconds instead of starting a job: list a folder, read a file, find
// files by name or content. Only GET requests, only on the deployment's repos.
// Takes `fetch` so tests run without the network.

const API = "https://api.github.com";
const MAX_TEXT = 100_000;
const MAX_FOUND = 50;
const TEXT_EXTENSIONS = new Set([
  "md",
  "mdx",
  "txt",
  "json",
  "yaml",
  "yml",
  "toml",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "html",
  "htm",
  "svg",
  "xml",
  "csv",
  "sql",
  "sh",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "prisma",
  "graphql",
  "env",
  "example",
  "lock",
  "mjml",
  "hbs",
  "liquid",
  "njk",
  "vue",
  "svelte",
  "astro",
  "gitignore",
  "dockerfile",
]);

export class GitHubError extends Error {
  override readonly name = "GitHubError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface RepoEntry {
  readonly path: string;
  readonly type: "file" | "dir" | string;
  readonly size?: number;
}

/** A path inside a repo: no leading slash, no `..`. */
export function repoPath(raw: string | undefined): string {
  const path = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (path.split("/").some((segment) => segment === ".."))
    throw new GitHubError(`"${raw}" leaves the repo`, 400);
  return path;
}

const looksText = (path: string) => {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(name.includes(".") ? (name.split(".").at(-1) ?? "") : name);
};

export class GitHubReader {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchFn: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchFn;
  }

  async #get(path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const response = await this.#fetch(`${API}${path}`, {
      headers: { authorization: `Bearer ${this.#token}`, accept, "x-github-api-version": "2022-11-28" },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = /"message"\s*:\s*"([^"]+)"/.exec(detail)?.[1] ?? response.statusText;
      throw new GitHubError(`GitHub ${response.status}: ${message}`, response.status);
    }
    return response;
  }

  /** The files and folders in one folder. */
  async list(github: string, folder: string, ref?: string): Promise<RepoEntry[]> {
    const path = repoPath(folder);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const data = (await (await this.#get(`/repos/${github}/contents/${path}${query}`)).json()) as unknown;
    if (!Array.isArray(data)) throw new GitHubError(`${path || "/"} is a file; read it instead`, 400);
    return (data as { path: string; type: string; size: number }[]).map((entry) => ({
      path: entry.path,
      type: entry.type,
      ...(entry.type === "file" ? { size: entry.size } : {}),
    }));
  }

  /** One file: its text, or for a binary file only its size. */
  async read(
    github: string,
    file: string,
    ref?: string,
  ): Promise<{ path: string; size: number; text?: string }> {
    const path = repoPath(file);
    if (!path) throw new GitHubError("name a file", 400);
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const bytes = new Uint8Array(
      await (
        await this.#get(`/repos/${github}/contents/${path}${query}`, "application/vnd.github.raw+json")
      ).arrayBuffer(),
    );
    if (!looksText(path) && bytes.includes(0)) return { path, size: bytes.byteLength };
    const text = new TextDecoder().decode(bytes);
    return {
      path,
      size: bytes.byteLength,
      text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut at ${MAX_TEXT} characters]` : text,
    };
  }

  /** Files whose path contains the words, case-insensitively, across the whole branch. */
  async findPaths(github: string, words: string, ref: string): Promise<string[]> {
    const tree = (await (
      await this.#get(`/repos/${github}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
    ).json()) as {
      tree: { path: string; type: string }[];
    };
    const terms = words.toLowerCase().split(/\s+/).filter(Boolean);
    return tree.tree
      .filter(
        (entry) => entry.type === "blob" && terms.every((term) => entry.path.toLowerCase().includes(term)),
      )
      .map((entry) => entry.path)
      .slice(0, MAX_FOUND);
  }

  /** Files whose content matches, from GitHub's code search on the default branch, with the matching lines. */
  async searchCode(github: string, words: string): Promise<{ path: string; matches: string[] }[]> {
    const q = encodeURIComponent(`${words} repo:${github}`);
    const data = (await (
      await this.#get(`/search/code?q=${q}&per_page=20`, "application/vnd.github.text-match+json")
    ).json()) as { items: { path: string; text_matches?: { fragment: string }[] }[] };
    return data.items.map((item) => ({
      path: item.path,
      matches: (item.text_matches ?? []).map((match) => match.fragment.trim().slice(0, 300)),
    }));
  }
}
