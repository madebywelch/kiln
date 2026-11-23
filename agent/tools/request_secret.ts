import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { resolveJobId, viewJob } from "../../lib/board-jobs.ts";
import { configuredProjects } from "../../lib/deployment.ts";
import { expiryIssue } from "../../lib/secret-labels.ts";
import { GROUP_MEANING, SECRET_GROUPS, secretNameIssue } from "../../lib/secrets.ts";
import { team } from "../lib/board.ts";
import { requestBlocks } from "../lib/secret-prompt.ts";
import { slackApi, slackHere } from "../lib/slack.ts";

export default defineDynamic(() => {
  const projects = configuredProjects();
  if (!projects) return null;
  const repoKeys = Object.keys(projects) as [string, ...string[]];

  return defineTool({
    description: [
      "Ask for a secret a repo's or project's jobs need, such as an API key for an MCP server or a database URL.",
      "Posts a button in this thread; whoever clicks it types the value into a private Slack form that saves it to",
      "the group's secrets. You never see the value. Never ask anyone to paste a secret in a message.",
      "Each secret belongs to one group, by how far it reaches, and only jobs started with that group get it:",
      ...SECRET_GROUPS.map((group) => `- ${group}: ${GROUP_MEANING[group]}.`),
      "Its name says what it is, behind its group's prefix: staging names are plain (DATABASE_URL), production-read",
      "names start PROD_READ_ (PROD_READ_DATABASE_URL), production-write names PROD_WRITE_. No other environment",
      "words: not STAGING_DATABASE_URL or DATABASE_URL_PROD. Only the person who made a credential knows how far it",
      "reaches: when it isn't clear, ask them which group before asking for it.",
      "Use it when a job is paused for a secret (pass its job, and saving the last one it needs resumes it), or when",
      "someone wants one set. Then say what it's for and stop; the thread hears when it's saved.",
    ].join("\n"),
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      group: z.enum(SECRET_GROUPS),
      name: z.string().describe("The environment variable, in capitals: LINEAR_API_KEY."),
      description: z
        .string()
        .min(1)
        .max(300)
        .describe(
          'What it is and what it reaches, kept with the secret and shown to jobs: "Stripe live key, read only".',
        ),
      expires: z
        .string()
        .optional()
        .describe(
          "The day it stops working, YYYY-MM-DD, when it has one, such as a token issued for a week.",
        ),
      job: z
        .string()
        .optional()
        .describe("The job paused for this secret, e.g. #b799fe5c. Saving the last one it needs resumes it."),
    }),
    label: { start: ({ repo, group, name }) => `Ask for ${name} in ${repo}'s ${group} secrets` },
    async execute({ repo, group, name, description, expires, job }, ctx) {
      const issue = secretNameIssue(name, group) ?? (expires ? expiryIssue(expires) : null);
      if (issue) throw new Error(issue);
      const here = slackHere(ctx);
      if (!here) throw new Error("not in Slack: a secret can only be asked for in a Slack conversation");
      const jobId = job ? await resolveJobId(team, job) : undefined;
      if (jobId) {
        const paused = viewJob((await team.thread(jobId, { limit: 1 })).message);
        if (paused.secrets !== group)
          throw new Error(
            paused.secrets === "none"
              ? `#${paused.ref} runs with no secrets, so saving one can't resume it: ask for it without job, then start the job again with secrets ${group}`
              : `#${paused.ref} runs with its ${paused.secrets} secrets; ask for it in that group, or without job`,
          );
      }
      await slackApi(
        "chat.postMessage",
        {
          channel: here.channelId,
          ...(here.threadTs ? { thread_ts: here.threadTs } : {}),
          text: `${repo} needs ${name}`,
          blocks: requestBlocks({
            repo,
            group,
            name,
            description,
            ...(expires ? { expires } : {}),
            ...(jobId ? { job: jobId } : {}),
          }),
        },
        here.teamId,
      );
      return { asked: name, repo, group, ...(job ? { resumes: job } : {}) };
    },
  });
});
