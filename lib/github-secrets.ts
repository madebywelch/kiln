// Copies a kiln secret into GitHub Actions, for a repo's deploy workflows,
// without a model or a sandbox seeing it. The agent's function reads the value
// from boat (or has it in hand from the Slack form that just saved it), seals
// it with the target's public key as GitHub requires, and PUTs it. The agent
// does everything else on GitHub with `gh` in its sandbox: environments and
// their protection rules, workflows, listing and deleting GitHub secrets.

import sodium from "libsodium-wrappers";
import type { Boat, Fetch } from "./boat.ts";
import type { DriveStore } from "./drive.ts";
import { readSecretLabels, updateSecretLabel } from "./secret-labels.ts";
import { environmentName, GROUP_PREFIX, type SecretGroup, secretValue } from "./secrets.ts";

const API = "https://api.github.com";

/** Where a secret is copied in GitHub. */
export interface GitHubCopy {
  /** owner/name. */
  readonly repo: string;
  /** A GitHub environment; without one, a repository Actions secret. */
  readonly environment?: string;
  /** The secret's name in GitHub. */
  readonly name: string;
}

export class GitHubSecretError extends Error {}

/**
 * A secret's name in GitHub: its kiln name without the group's prefix. In GitHub, the environment
 * says how far a secret reaches, and a workflow reads the plain name its code expects.
 */
export const githubName = (name: string, group: SecretGroup): string =>
  name.slice(GROUP_PREFIX[group].length);

/** Why a name can't be a GitHub secret's, or null when it can. */
export function githubNameIssue(name: string): string | null {
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name))
    return `${name || "an empty name"} can't be a GitHub secret's name: capitals, digits, and underscores, not starting with a digit`;
  if (name.startsWith("GITHUB_")) return `GitHub reserves names starting GITHUB_, so ${name} can't be one`;
  return null;
}

export const describeCopy = (copy: GitHubCopy): string =>
  `${copy.repo}${copy.environment ? `'s ${copy.environment} environment` : ""} as ${copy.name}`;

export const sameCopy = (a: GitHubCopy, b: GitHubCopy): boolean =>
  a.repo.toLowerCase() === b.repo.toLowerCase() &&
  (a.environment ?? "") === (b.environment ?? "") &&
  a.name === b.name;

/** The value sealed with a GitHub public key (libsodium's sealed box), base64, as GitHub's API takes it. */
export async function sealSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const key = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  return sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), key),
    sodium.base64_variants.ORIGINAL,
  );
}

function failure(status: number, copy: GitHubCopy, message: string): string {
  const where = copy.environment ? `${copy.repo}'s ${copy.environment} environment` : copy.repo;
  if (status === 404)
    return copy.environment
      ? `${copy.repo} has no ${copy.environment} environment, or the agent's GitHub token can't see it. Create it first, with its protection rules: gh api -X PUT repos/${copy.repo}/environments/${copy.environment}`
      : `the agent's GitHub token can't see ${copy.repo}`;
  if (status === 401 || status === 403)
    return `the agent's GitHub token can't write secrets in ${where} (${status}): it needs Secrets read and write${copy.environment ? ", and Environments read and write" : ""}, on ${copy.repo}`;
  return `GitHub answered ${status} for ${where}: ${message.slice(0, 200)}`;
}

/** Creates or replaces one GitHub Actions secret. Throws GitHubSecretError with what to do. */
export async function putGitHubSecret(
  token: string,
  copy: GitHubCopy,
  value: string,
  fetchFn: Fetch = fetch,
): Promise<void> {
  const issue = githubNameIssue(copy.name);
  if (issue) throw new GitHubSecretError(issue);
  if (!/^[\w.-]+\/[\w.-]+$/.test(copy.repo)) throw new GitHubSecretError(`${copy.repo} isn't owner/name`);
  const base = copy.environment
    ? `/repos/${copy.repo}/environments/${encodeURIComponent(copy.environment)}/secrets`
    : `/repos/${copy.repo}/actions/secrets`;
  const call = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const response = await fetchFn(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "kiln",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.ok) return response.status === 204 || response.status === 201 ? undefined : response.json();
    let message = "";
    try {
      message = String(((await response.json()) as { message?: unknown }).message ?? "");
    } catch {
      // no JSON body
    }
    throw new GitHubSecretError(failure(response.status, copy, message));
  };
  const { key_id, key } = (await call("GET", `${base}/public-key`)) as { key_id: string; key: string };
  await call("PUT", `${base}/${copy.name}`, { encrypted_value: await sealSecret(value, key), key_id });
}

export interface CopyDeps {
  readonly boat: Boat;
  /** Where secret labels live; each copy is recorded on its secret's label. */
  readonly labels: DriveStore;
  /** The agent's GitHub token, used here in its own function and never in a sandbox. */
  readonly token: string | undefined;
  /** The GitHub repos (owner/name) of a kiln repo or project. */
  readonly githubRepos: (key: string) => readonly string[];
  readonly fetch?: Fetch;
}

export interface CopyRequest {
  readonly repo: string;
  readonly group: SecretGroup;
  readonly github: string;
  readonly environment?: string;
  readonly secrets: readonly { readonly name: string; readonly as: string }[];
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why these secrets can't go to this GitHub target, or null when they can. */
export function copyIssue(
  deps: Pick<CopyDeps, "token" | "githubRepos">,
  request: CopyRequest,
): string | null {
  if (!deps.token) return "the agent has no GitHub token (KILN_GH_TOKEN)";
  const repos = deps.githubRepos(request.repo);
  if (!repos.some((repo) => repo.toLowerCase() === request.github.toLowerCase()))
    return `${request.github} isn't one of ${request.repo}'s repos (${repos.join(", ") || "none"})`;
  if (request.group !== "staging" && !request.environment)
    return `${request.group} secrets go only into a GitHub environment, whose protection rules say which branches and people can deploy with them`;
  for (const { as } of request.secrets) {
    const issue = githubNameIssue(as);
    if (issue) return issue;
  }
  return null;
}

/**
 * Copies secrets from boat into GitHub Actions and records each copy on its secret's label, so saving
 * the secret again updates it. Returns what happened, as a sentence for the thread, without values.
 */
export async function copySecretsToGitHub(deps: CopyDeps, request: CopyRequest): Promise<string> {
  const issue = copyIssue(deps, request);
  if (issue) return `couldn't copy secrets to GitHub: ${issue}.`;
  const token = deps.token as string;
  const copied: string[] = [];
  const failed: string[] = [];
  for (const { name, as } of request.secrets) {
    const copy: GitHubCopy = {
      repo: request.github,
      ...(request.environment ? { environment: request.environment } : {}),
      name: as,
    };
    try {
      await putGitHubSecret(
        token,
        copy,
        await secretValue(deps.boat, request.repo, request.group, name),
        deps.fetch,
      );
      await updateSecretLabel(deps.labels, environmentName(request.repo, request.group), name, (label) => ({
        ...(label ?? { description: "", savedBy: "", savedAt: "" }),
        github: [...(label?.github ?? []).filter((other) => !sameCopy(other, copy)), copy],
      }));
      copied.push(name === as ? `\`${name}\`` : `\`${name}\` as \`${as}\``);
    } catch (error) {
      failed.push(`\`${name}\`: ${errorText(error)}`);
    }
  }
  const target = request.environment
    ? `${request.github}'s ${request.environment} environment`
    : `${request.github}'s repository secrets`;
  const done = copied.length
    ? `copied ${copied.join(", ")} from *${request.repo}*'s *${request.group}* secrets to ${target}.`
    : `couldn't copy secrets to ${target}.`;
  return failed.length ? `${done} Not copied: ${failed.join("; ")}.` : done;
}

/**
 * After a secret is saved again, puts the new value in each of its GitHub copies. Returns what happened,
 * as a sentence for the thread, or undefined when it has none.
 */
export async function updateGitHubCopies(
  deps: Pick<CopyDeps, "labels" | "token" | "fetch">,
  environment: string,
  name: string,
  value: string,
): Promise<string | undefined> {
  const copies = (await readSecretLabels(deps.labels))[environment]?.[name]?.github ?? [];
  if (copies.length === 0) return undefined;
  if (!deps.token) return "Its GitHub copies weren't updated: the agent has no GitHub token (KILN_GH_TOKEN).";
  const updated: string[] = [];
  const failed: string[] = [];
  for (const copy of copies) {
    try {
      await putGitHubSecret(deps.token, copy, value, deps.fetch);
      updated.push(describeCopy(copy));
    } catch (error) {
      failed.push(`${describeCopy(copy)}: ${errorText(error)}`);
    }
  }
  return [
    updated.length ? `Updated in GitHub: ${updated.join("; ")}.` : "",
    failed.length ? `Not updated in GitHub: ${failed.join("; ")}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
