// A pull request a change job continues: the worker adds its commits to the pull
// request's branch, so the same pull request stays open, with its CI history,
// review, labels, and draft or ready state, instead of a new one replacing it.

import type { ProjectRepo } from "./deployment.ts";

export interface ContinuedPull {
  /** The repo's key in kiln.config.yaml. */
  readonly repo: string;
  readonly number: number;
  /** Its head branch, which the job checks out and pushes to. */
  readonly branch: string;
  /** Its head commit when the job was started: commits after it are the job's. */
  readonly head: string;
}

export class PullRequestError extends Error {
  override readonly name = "PullRequestError";
}

interface PullResponse {
  state?: string;
  merged?: boolean;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string };
}

/**
 * The open pull request `number` on `github`, checked so a job can push to its branch: open, its branch in
 * the same repo (not a fork the token can't push to), and not the repo's base branch.
 */
export async function pullToContinue(
  token: string | undefined,
  repo: { readonly key: string; readonly github: string; readonly baseBranch?: string | undefined },
  number: number,
  fetchFn: typeof fetch = fetch,
): Promise<ContinuedPull> {
  if (!token)
    throw new PullRequestError(
      "no GitHub token on the agent's project (KILN_GH_TOKEN), so I can't read the pull request",
    );
  const response = await fetchFn(`https://api.github.com/repos/${repo.github}/pulls/${number}`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (response.status === 404) throw new PullRequestError(`${repo.github} has no pull request #${number}`);
  if (!response.ok)
    throw new PullRequestError(`GitHub answered ${response.status} for ${repo.github}#${number}`);
  const pull = (await response.json()) as PullResponse;
  if (pull.state !== "open") {
    throw new PullRequestError(
      `${repo.github}#${number} is ${pull.merged ? "merged" : "closed"}; continue only an open pull request, or start a new job`,
    );
  }
  const branch = pull.head?.ref;
  const head = pull.head?.sha;
  if (!branch || !head) throw new PullRequestError(`GitHub gave no head branch for ${repo.github}#${number}`);
  if (pull.head?.repo?.full_name !== repo.github) {
    throw new PullRequestError(
      `${repo.github}#${number} comes from another repo (a fork), which jobs can't push to`,
    );
  }
  if (branch === (repo.baseBranch ?? "main")) {
    throw new PullRequestError(
      `${repo.github}#${number} is from ${branch}, the base branch; jobs never push to it`,
    );
  }
  return { repo: repo.key, number, branch, head };
}

/** The repo a continued pull request is on: the only one, or the named one of a project's. */
export function pullRequestRepo(
  members: readonly ProjectRepo[],
  kind: string,
  named: string | undefined,
): ProjectRepo {
  if (kind !== "change") throw new PullRequestError("only a change job continues a pull request");
  if (named) {
    const member = members.find((candidate) => candidate.key === named);
    if (!member)
      throw new PullRequestError(
        `${named} isn't one of this project's repos (${members.map((m) => m.key).join(", ")})`,
      );
    return member;
  }
  const [only, ...others] = members;
  if (!only || others.length > 0)
    throw new PullRequestError(
      `say which repo the pull request is on (pull_request_repo): ${members.map((m) => m.key).join(", ")}`,
    );
  return only;
}
