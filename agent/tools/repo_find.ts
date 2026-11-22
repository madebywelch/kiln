import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { configuredRepos } from "../../lib/deployment.ts";
import { GitHubError } from "../../lib/github.ts";
import { githubReader } from "../lib/github.ts";

// Read-only. Built per call from kiln.config.yaml, so it offers only this deployment's repos.
export default defineDynamic(() => {
  const repos = configuredRepos();
  if (!repos) return null;
  const repoKeys = Object.keys(repos) as [string, ...string[]];
  return defineTool({
    description:
      "Find files in one of your repos, read-only and instant: by words in their path (every word must appear), and by words in their content (GitHub's code search, on the default branch). Use it to locate a doc or code someone mentions, then repo_read it.",
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      words: z.string().min(1).describe("Such as: thanksgiving email."),
    }),
    label: false,
    async execute({ repo, words }) {
      const reader = githubReader();
      if (typeof reader === "string") throw new Error(reader);
      const config = repos[repo];
      const github = config?.github ?? "";
      const byPath = await reader.findPaths(github, words, config?.baseBranch ?? "main");
      let byContent: Awaited<ReturnType<typeof reader.searchCode>> | string;
      try {
        byContent = await reader.searchCode(github, words);
      } catch (error) {
        // Code search can refuse some tokens or queries; path matches still answer.
        byContent =
          error instanceof GitHubError ? `code search unavailable: ${error.message}` : String(error);
      }
      return { repo, byPath, byContent };
    },
  });
});
