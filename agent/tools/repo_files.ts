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
      "List the files and folders in a folder of one of your repos, read-only and instant. Look here before asking someone what is in a repo or starting a job to find out.",
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      folder: z.string().optional().describe("A folder, such as apps/email. Default: the repo's root."),
      ref: z.string().optional().describe("A branch, tag, or commit. Default: the repo's base branch."),
    }),
    label: false,
    async execute({ repo, folder, ref }) {
      const reader = githubReader();
      if (typeof reader === "string") throw new Error(reader);
      const config = repos[repo];
      const entries = await reader.list(config?.github ?? "", folder ?? "", ref ?? config?.baseBranch);
      return { repo, folder: folder ?? "/", entries };
    },
  });
});
