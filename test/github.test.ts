import { describe, expect, it } from "vitest";
import { GitHubError, GitHubReader, repoPath } from "../lib/github.ts";

function fakeGitHub(routes: Record<string, () => Response>) {
  const calls: { url: string; method: string; accept: string }[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input).replace("https://api.github.com", "");
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", accept: headers.get("accept") ?? "" });
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    return route
      ? (routes[route] as () => Response)()
      : Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { reader: new GitHubReader("t", fetchFn), calls };
}

describe("GitHubReader", () => {
  it("lists a folder at a ref, and says when the path is a file", async () => {
    const { reader, calls } = fakeGitHub({
      "/repos/acme/web/contents/emails?ref=main": () =>
        Response.json([
          { path: "emails/thanksgiving.mjml", type: "file", size: 812 },
          { path: "emails/assets", type: "dir", size: 0 },
        ]),
      "/repos/acme/web/contents/README.md": () => Response.json({ path: "README.md", type: "file" }),
    });
    expect(await reader.list("acme/web", "/emails/", "main")).toEqual([
      { path: "emails/thanksgiving.mjml", type: "file", size: 812 },
      { path: "emails/assets", type: "dir" },
    ]);
    await expect(reader.list("acme/web", "README.md")).rejects.toThrow(/is a file/);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("reads a text file raw, and gives only the size of a binary one", async () => {
    const { reader, calls } = fakeGitHub({
      "/repos/acme/web/contents/emails/thanksgiving.mjml": () => new Response("<mjml>Gobble</mjml>"),
      "/repos/acme/web/contents/hero.png": () => new Response(new Uint8Array([0x89, 0x50, 0x00, 0x01])),
    });
    expect(await reader.read("acme/web", "emails/thanksgiving.mjml")).toEqual({
      path: "emails/thanksgiving.mjml",
      size: 19,
      text: "<mjml>Gobble</mjml>",
    });
    expect(await reader.read("acme/web", "hero.png")).toEqual({ path: "hero.png", size: 4 });
    expect(calls[0]?.accept).toBe("application/vnd.github.raw+json");
  });

  it("finds files whose path has every word, across the branch", async () => {
    const { reader } = fakeGitHub({
      "/repos/acme/web/git/trees/main?recursive=1": () =>
        Response.json({
          tree: [
            { path: "tools/email-cli/drafts/Thanksgiving-2026.md", type: "blob" },
            { path: "tools/email-cli/drafts", type: "tree" },
            { path: "app/thanksgiving/page.tsx", type: "blob" },
          ],
        }),
    });
    expect(await reader.findPaths("acme/web", "thanksgiving email", "main")).toEqual([
      "tools/email-cli/drafts/Thanksgiving-2026.md",
    ]);
  });

  it("returns code search matches with their lines, and names GitHub's refusal", async () => {
    const { reader } = fakeGitHub({
      "/search/code?q=gobble%20repo%3Aacme%2Fweb": () =>
        Response.json({
          items: [{ path: "emails/t.mjml", text_matches: [{ fragment: "  Gobble gobble  " }] }],
        }),
      "/search/code?q=blocked": () => Response.json({ message: "Must have push access" }, { status: 403 }),
    });
    expect(await reader.searchCode("acme/web", "gobble")).toEqual([
      { path: "emails/t.mjml", matches: ["Gobble gobble"] },
    ]);
    await expect(reader.searchCode("x", "blocked")).rejects.toThrow(GitHubError);
  });

  it("keeps paths inside the repo", () => {
    expect(repoPath("/docs/plan.md/")).toBe("docs/plan.md");
    expect(() => repoPath("docs/../../etc")).toThrow(/leaves the repo/);
  });
});
