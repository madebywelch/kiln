import { describe, expect, it } from "vitest";
import type { ProjectRepo } from "../lib/deployment.ts";
import { PullRequestError, pullRequestRepo, pullToContinue } from "../lib/github-pulls.ts";

const web = { key: "web", github: "acme/web", description: "the website" } satisfies ProjectRepo;
const api = {
  key: "api",
  github: "acme/api",
  baseBranch: "trunk",
  description: "the API",
} satisfies ProjectRepo;

const open = {
  state: "open",
  merged: false,
  head: { ref: "octo/fix-ci", sha: "a1b2c3d4", repo: { full_name: "acme/web" } },
  base: { ref: "main" },
};

/** A fetch that answers one pull request, recording what it was asked. */
function github(status: number, body: unknown) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: init?.headers as Record<string, string> });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("pullToContinue", () => {
  it("returns an open pull request's branch and head, asked with the agent's token", async () => {
    const { calls, fetchFn } = github(200, open);
    await expect(pullToContinue("tok", web, 12, fetchFn)).resolves.toEqual({
      repo: "web",
      number: 12,
      branch: "octo/fix-ci",
      head: "a1b2c3d4",
    });
    expect(calls).toEqual([
      {
        url: "https://api.github.com/repos/acme/web/pulls/12",
        headers: expect.objectContaining({ authorization: "Bearer tok" }),
      },
    ]);
  });

  it("refuses without a token, before asking GitHub", async () => {
    const { calls, fetchFn } = github(200, open);
    await expect(pullToContinue(undefined, web, 12, fetchFn)).rejects.toThrow(/no GitHub token/);
    expect(calls).toEqual([]);
  });

  it.each([
    ["a missing pull request", 404, {}, /no pull request #12/],
    ["an error from GitHub", 502, {}, /answered 502/],
    ["a merged pull request", 200, { ...open, state: "closed", merged: true }, /is merged/],
    ["a closed pull request", 200, { ...open, state: "closed" }, /is closed/],
    [
      "a fork's pull request",
      200,
      { ...open, head: { ...open.head, repo: { full_name: "octo/web" } } },
      /fork/,
    ],
    ["a deleted fork's pull request", 200, { ...open, head: { ...open.head, repo: null } }, /fork/],
    ["a pull request with no head", 200, { state: "open" }, /no head branch/],
    ["the base branch", 200, { ...open, head: { ...open.head, ref: "main" } }, /base branch/],
  ])("refuses %s", async (_, status, body, error) => {
    const { fetchFn } = github(status, body);
    const refusal = pullToContinue("tok", web, 12, fetchFn);
    await expect(refusal).rejects.toThrow(PullRequestError);
    await expect(refusal).rejects.toThrow(error);
  });

  it("checks against the repo's own base branch", async () => {
    const onApi = { ...open, head: { ...open.head, ref: "trunk", repo: { full_name: "acme/api" } } };
    await expect(pullToContinue("tok", api, 3, github(200, onApi).fetchFn)).rejects.toThrow(/base branch/);
    const onMain = { ...onApi, head: { ...onApi.head, ref: "main" } };
    await expect(pullToContinue("tok", api, 3, github(200, onMain).fetchFn)).resolves.toMatchObject({
      branch: "main",
    });
  });
});

describe("pullRequestRepo", () => {
  it("takes a single repo's only repo, or the named one of a project's", () => {
    expect(pullRequestRepo([web], "change", undefined)).toBe(web);
    expect(pullRequestRepo([web, api], "change", "api")).toBe(api);
  });

  it("refuses an investigate job, an unnamed project repo, or one outside the project", () => {
    expect(() => pullRequestRepo([web], "investigate", undefined)).toThrow(/only a change job/);
    expect(() => pullRequestRepo([web, api], "change", undefined)).toThrow(/\(pull_request_repo\): web, api/);
    expect(() => pullRequestRepo([web], "change", "api")).toThrow(
      /isn't one of this project's repos \(web\)/,
    );
    expect(() => pullRequestRepo([], "change", undefined)).toThrow(PullRequestError);
  });
});
