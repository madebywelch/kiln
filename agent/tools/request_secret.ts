import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveJobId } from "../../lib/board-jobs.ts";
import { configuredRepos } from "../../lib/deployment.ts";
import { secretNameIssue } from "../../lib/secrets.ts";
import { team } from "../lib/board.ts";
import { requestBlocks } from "../lib/secret-prompt.ts";
import { slackApi, slackHere } from "../lib/slack.ts";

export default defineDynamic(() => {
  const repos = configuredRepos();
  if (!repos) return null;
  const repoKeys = Object.keys(repos) as [string, ...string[]];

  return defineTool({
    description: [
      "Ask for a secret a repo's jobs need, such as an API key for an MCP server or a test database URL.",
      "Posts a button in this thread; whoever clicks it types the value into a private Slack form that saves",
      "it to the repo's own secrets. You never see the value. Never ask anyone to paste a secret in a message.",
      "Use it when a job is paused for a secret (pass its job ID, and saving resumes the job), or when someone",
      "wants one set. Then say what it's for and stop; the thread hears when it's saved.",
    ].join(" "),
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      name: z.string().describe("The environment variable, in capitals: LINEAR_API_KEY."),
      why: z.string().max(300).describe("One sentence on what it's for, shown above the button."),
      job: z
        .string()
        .optional()
        .describe("The job paused for this secret, e.g. #b799fe5c. Saving the last one it needs resumes it."),
    }),
    label: { start: ({ repo, name }) => `Ask for ${name} on ${repo}` },
    async execute({ repo, name, why, job }, ctx) {
      const issue = secretNameIssue(name);
      if (issue) throw new Error(issue);
      const here = slackHere(ctx);
      if (!here) throw new Error("not in Slack: a secret can only be asked for in a Slack conversation");
      const jobId = job ? await resolveJobId(team, job) : undefined;
      await slackApi(
        "chat.postMessage",
        {
          channel: here.channelId,
          ...(here.threadTs ? { thread_ts: here.threadTs } : {}),
          text: `${repo} needs ${name}`,
          blocks: requestBlocks({ repo, name, ...(jobId ? { job: jobId } : {}) }, why),
        },
        here.teamId,
      );
      return { asked: name, repo, ...(job ? { resumes: job } : {}) };
    },
  });
});
