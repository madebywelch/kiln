// The agent's read-only view of its repos. KILN_REPO_READ_TOKEN is a GitHub
// token with read access to the repos in kiln.config.yaml; without it, the
// workers' token is used, and the tools still only read.

import { GitHubReader } from "../../lib/github.ts";

export function githubReader(): GitHubReader | string {
  const token = process.env.KILN_REPO_READ_TOKEN || process.env.WORKER_GH_TOKEN;
  return token
    ? new GitHubReader(token)
    : "set KILN_REPO_READ_TOKEN on the agent's Vercel project to read repos";
}
