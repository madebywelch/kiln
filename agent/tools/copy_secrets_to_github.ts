import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { agentGitHubToken } from "../../lib/config.ts";
import { configuredProjects } from "../../lib/deployment.ts";
import { copyIssue, githubName } from "../../lib/github-secrets.ts";
import { SECRET_GROUPS, secretNames } from "../../lib/secrets.ts";
import { boatClient } from "../lib/machines.ts";
import { copyBlocks, type GitHubCopyRequest } from "../lib/secret-prompt.ts";
import { slackApi, slackHere } from "../lib/slack.ts";

const MAX_SECRETS = 10;

export default defineDynamic(() => {
  const projects = configuredProjects();
  if (!projects) return null;
  const repoKeys = Object.keys(projects) as [string, ...string[]];
  const githubRepos = (key: string) => projects[key]?.repos.map((repo) => repo.github) ?? [];

  return defineTool({
    description: [
      "Offer to copy secrets from a repo's or project's group into GitHub Actions secrets, such as the keys a deploy",
      "workflow needs. Posts a Copy button in this thread; the values go from boat to GitHub, sealed with the repo's",
      "key, only when a person clicks it and confirms, and you never see them. Saving one of these secrets again in",
      "kiln updates its GitHub copies.",
      "In GitHub a secret takes its kiln name without the group's prefix (PROD_WRITE_FLY_API_TOKEN becomes",
      "FLY_API_TOKEN), since the GitHub environment says how far it reaches; pass `as` for another name.",
      "Production secrets go only into a GitHub environment. Set it up first with gh in your sandbox, with",
      "protection rules (deployment branches, required reviewers): gh api -X PUT repos/OWNER/REPO/environments/NAME.",
      "Do the rest of GitHub with gh too: workflows, listing and deleting GitHub secrets. Never gh secret set: a",
      "value would have to pass through you.",
    ].join("\n"),
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      group: z.enum(SECRET_GROUPS),
      github_repo: z
        .string()
        .describe("The GitHub repo to copy into, owner/name: one of the project's repos."),
      environment: z
        .string()
        .min(1)
        .max(255)
        .optional()
        .describe("A GitHub environment, such as production. Without one, repository secrets: staging only."),
      secrets: z
        .array(
          z.object({
            name: z.string().describe("The secret's kiln name, as list_secrets shows it."),
            as: z
              .string()
              .optional()
              .describe("Its name in GitHub, when not the kiln name without the prefix."),
          }),
        )
        .min(1)
        .max(MAX_SECRETS),
      why: z.string().max(300).describe("One sentence on what they're for, shown above the button."),
    }),
    label: {
      start: ({ repo, github_repo, environment }) =>
        `Offer to copy ${repo}'s secrets to ${github_repo}${environment ? ` (${environment})` : ""}`,
    },
    async execute(input, ctx) {
      const here = slackHere(ctx);
      if (!here) throw new Error("not in Slack: secrets can only be copied from a Slack conversation");
      const request: GitHubCopyRequest = {
        repo: input.repo,
        group: input.group,
        github: input.github_repo,
        ...(input.environment ? { environment: input.environment } : {}),
        secrets: input.secrets.map(({ name, as }) => ({ name, as: as ?? githubName(name, input.group) })),
      };
      const issue = copyIssue({ token: agentGitHubToken(), githubRepos }, request);
      if (issue) throw new Error(issue);
      const boat = boatClient();
      if (typeof boat === "string") throw new Error(boat);
      const have = await secretNames(boat, input.repo, input.group);
      const missing = request.secrets.map((s) => s.name).filter((name) => !have.includes(name));
      if (missing.length)
        throw new Error(
          `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} in ${input.repo}'s ${input.group} secrets (it has ${have.join(", ") || "none"})`,
        );
      await slackApi(
        "chat.postMessage",
        {
          channel: here.channelId,
          ...(here.threadTs ? { thread_ts: here.threadTs } : {}),
          text: `Copy ${input.repo}'s ${input.group} secrets to ${input.github_repo}?`,
          blocks: copyBlocks(request, input.why),
        },
        here.teamId,
      );
      return {
        offered: request.secrets.map(({ name, as }) => (name === as ? name : `${name} as ${as}`)),
        to: `${request.github}${request.environment ? ` environment ${request.environment}` : ""}`,
      };
    },
  });
});
