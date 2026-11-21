// Deploys the agent and pins the worker code its machines run to the same commit.
//
//   pnpm run deploy
//
// Job machines download kiln from GitHub at the commit the agent was deployed
// from, so the tree must be clean and the commit pushed. The commit's tarball
// URL goes into the Vercel project's environment as KILN_WORKER_CODE, then
// `eve deploy` ships the agent.

import { execFileSync } from "node:child_process";

const sh = (command: string, args: string[], input?: string) =>
  execFileSync(command, args, {
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "inherit" : "pipe", "pipe", "inherit"],
  }).trim();

/** The GitHub `owner/name` of a remote URL, or null when it isn't GitHub. */
export function githubRepo(remote: string): string | null {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(remote.trim());
  return match?.[1] ?? null;
}

export function workerCodeUrl(repo: string, commit: string): string {
  return `https://codeload.github.com/${repo}/tar.gz/${commit}`;
}

async function main(): Promise<void> {
  if (sh("git", ["status", "--porcelain"]))
    throw new Error("commit or stash your changes first: machines run the deployed commit");
  const commit = sh("git", ["rev-parse", "HEAD"]);
  if (!sh("git", ["branch", "-r", "--contains", commit]))
    throw new Error(`push ${commit.slice(0, 7)} first: machines download it from GitHub`);
  const repo = githubRepo(sh("git", ["remote", "get-url", "origin"]));
  if (!repo) throw new Error("origin is not a GitHub repo; machines download kiln from GitHub");
  const code = workerCodeUrl(repo, commit);
  const probe = await fetch(code, { method: "HEAD" });
  if (!probe.ok)
    throw new Error(`${code} answered ${probe.status}; the repo must be public for machines to download it`);

  process.stdout.write(`pinning job machines to ${commit.slice(0, 7)}\n`);
  sh("pnpm", ["exec", "vercel", "env", "add", "KILN_WORKER_CODE", "production", "--force"], code);
  execFileSync("pnpm", ["exec", "eve", "deploy", "--non-interactive", "--yes"], { stdio: "inherit" });
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
