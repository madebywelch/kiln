import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { configuredRepos } from "../../lib/deployment.ts";
import { githubReader } from "../lib/github.ts";

// Read-only. Built per call from kiln.config.yaml, so it offers only this deployment's repos.
export default defineDynamic(() => {
  const repos = configuredRepos();
  if (!repos) return null;
  const repoKeys = Object.keys(repos) as [string, ...string[]];
  return defineTool({
    description:
      "Read a file from one of your repos, read-only and instant: a doc, a draft, code, config. For a binary file you get its size; to see or render it, start a job.",
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      path: z.string().describe("The file's path in the repo, such as docs/plan.md."),
      ref: z.string().optional().describe("A branch, tag, or commit. Default: the repo's base branch."),
    }),
    label: false,
    async execute({ repo, path, ref }) {
      const reader = githubReader();
      if (typeof reader === "string") throw new Error(reader);
      const config = repos[repo];
      return { repo, ...(await reader.read(config?.github ?? "", path, ref ?? config?.baseBranch)) };
    },
  });
});
