import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { postJob } from "../../lib/board-jobs.ts";
import {
  agentGitHubToken,
  defaultSelection,
  EFFORTS,
  enabledHarnesses,
  type Harness,
} from "../../lib/config.ts";
import { configuredProjects } from "../../lib/deployment.ts";
import { drivePath } from "../../lib/drive.ts";
import { pullRequestRepo, pullToContinue } from "../../lib/github-pulls.ts";
import { collectJobFiles } from "../../lib/job-files.ts";
import {
  askerOfSession,
  describeSelection,
  KINDS,
  MAX_BRIEF_CHARS,
  MAX_JOB_FILE_BYTES,
  MAX_JOB_FILES,
  MAX_TITLE_CHARS,
  resolveSelection,
} from "../../lib/jobs.ts";
import { JOB_SECRETS } from "../../lib/secrets.ts";
import { team } from "../lib/board.ts";
import { drive } from "../lib/drive.ts";
import { launchNow } from "../lib/machines.ts";
import { reportsTo, reportThread, slackHere } from "../lib/slack.ts";

// Built per model call from kiln.config.yaml (KILN_CONFIG), so the public code names no repos.
// With none configured, the tool isn't offered.
export default defineDynamic(() => {
  const repos = configuredProjects();
  if (!repos) return null;
  const repoKeys = Object.keys(repos) as [string, ...string[]];
  const repoLines = Object.entries(repos).map(([key, repo]) => {
    const together =
      repo.repos.length > 1
        ? ` Project: ${repo.repos.map((member) => `${member.key} (${member.description})`).join(", ")}, cloned side by side.`
        : "";
    const own = Object.entries(repo.defaults ?? {})
      .map(
        ([kind, d]) =>
          `${kind}: ${describeSelection({ ...defaultSelection[kind as keyof typeof defaultSelection], ...d })}`,
      )
      .join(", ");
    return `- ${key}: ${repo.description}${together}${own ? ` (defaults: ${own})` : ""}`;
  });
  const HARNESS_LINES: Readonly<Record<Harness, string>> = {
    claude: "claude (Claude Code: opus, sonnet, haiku)",
    codex: "codex (Codex: gpt-5.5 and other OpenAI names)",
    opencode: "opencode (any AI Gateway model ID, billed per token)",
  };
  const harnessLines = enabledHarnesses.map((harness) => HARNESS_LINES[harness]);

  return defineTool({
    description: [
      "Hand work on a repo to the worker pool, each job in a fresh clone. A change job commits to its own",
      "branch and opens a draft pull request, or, given `pull_request`, adds its commits to that open pull",
      "request so the same one stays open (fixing its CI, a conflict, or a follow-up), keeping its review, labels,",
      "and draft or ready state: use that rather than a new job whose pull request replaces it. An investigate job only reports. The result comes back to this",
      "thread when the job settles. A project is several repos cloned side by side: a job on it can change any",
      "of them, and each one it changes gets its own draft pull request. Pick the project even when the work",
      "touches only one of its repos.",
      "",
      "Repos and projects:",
      ...repoLines,
      "",
      `Workers run ${harnessLines.join("; ")}, on the deployment's inference endpoint.`,
      "Models billed per token (AI Gateway IDs such as deepseek/..., or another vendor's models) are off. If someone",
      "asks for one, say so and offer a Claude model instead; don't start the job on something else.",
      "",
      `Unless the user names them: change jobs run on ${describeSelection(defaultSelection.change)} (the implementer), investigate jobs on ${describeSelection(defaultSelection.investigate)} (the researcher, fast).`,
      'Pass harness, model, or effort only when the user asked for them ("opus at max effort", "sonnet, low effort").',
    ].join("\n"),
    inputSchema: z.object({
      repo: z.enum(repoKeys),
      kind: z
        .enum(KINDS)
        .describe("change: commit and open a draft PR. investigate: report findings, change nothing."),
      title: z.string().min(1).max(MAX_TITLE_CHARS).describe("Short imperative title; also the PR title."),
      brief: z
        .string()
        .min(1)
        .max(MAX_BRIEF_CHARS)
        .describe(
          "Everything the worker needs, because it sees nothing else: the goal, the context and decisions from this " +
            "conversation, constraints, and how to tell it is done.",
        ),
      harness: z.enum(enabledHarnesses as [Harness, ...Harness[]]).optional(),
      model: z
        .string()
        .optional()
        .describe("The harness CLI's model name or alias, e.g. opus, sonnet, gpt-5.5."),
      effort: z.enum(EFFORTS).optional(),
      files: z
        .array(z.string())
        .max(MAX_JOB_FILES)
        .optional()
        .describe(
          `Files the worker needs, up to ${MAX_JOB_FILES}, ${MAX_JOB_FILE_BYTES / 1024 / 1024} MB each: drive paths (such as ` +
            "assets/favicon.ico), or sandbox paths such as a Slack attachment under /workspace/.eve/attachments/. " +
            "The worker finds them by file name in .kiln/inputs/. Say in the brief what to do with each, such as " +
            '"put favicon.ico at public/favicon.ico". Files go into the repo only if the brief says where.',
        ),
      channel_id: z
        .string()
        .optional()
        .describe(
          "Where the job's updates go, when not this thread: a Slack channel ID, such as a project's channel. " +
            "Without thread_ts, a short opener is posted there and its thread holds the updates.",
        ),
      secrets: z
        .enum(JOB_SECRETS)
        .default("none")
        .describe(
          "Which of the project's secret groups the job's machine gets as environment variables, and so which MCP " +
            "servers it can sign in to (list_secrets shows both). none, the default, for most jobs. staging for jobs " +
            "that need test or staging services. production-read for a job that must read production, never one " +
            "that runs code nobody vetted, such as third-party mods or new packages. production-write only when the " +
            "person asked for this job to change production. Name the secrets it should use in the brief.",
        ),
      priority: z
        .boolean()
        .optional()
        .describe(
          "Start before older queued jobs, for a job that can't wait its turn, such as one with a deadline. It " +
            "takes the next free slot; it doesn't stop running jobs.",
        ),
      thread_ts: z
        .string()
        .optional()
        .describe("A thread for the job's updates: its root message's ts, in channel_id or this channel."),
      pull_request: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Change jobs only: the number of an open pull request on one of this repo's or project's repos to add to. " +
            "The job checks out its branch, builds on it, and pushes there; it never force-pushes it.",
        ),
      pull_request_repo: z
        .string()
        .optional()
        .describe(
          "For a project: which of its repos (by key) the pull request is on. Not needed for a single repo.",
        ),
    }),
    label: { start: ({ repo, title }) => `Start job on ${repo}: ${title}` },
    async execute(input, ctx) {
      const selection = resolveSelection(input.repo, input.kind, input, repos);
      const continues = input.pull_request
        ? await pullToContinue(
            agentGitHubToken(process.env),
            pullRequestRepo(repos[input.repo]?.repos ?? [], input.kind, input.pull_request_repo),
            input.pull_request,
          )
        : undefined;
      const here = slackHere(ctx);
      const asker = askerOfSession(ctx.session.auth);
      const files = await collectJobFiles(input.files ?? [], {
        sandbox: async (path) => (await ctx.getSandbox()).readBinaryFile({ path }),
        drive: async (path) => (await (await drive()).read(drivePath(path)))?.bytes ?? null,
      });
      // After the files check, so a refused job leaves no opener behind.
      const thread = await reportThread(
        { channelId: input.channel_id, threadTs: input.thread_ts },
        here,
        `Job on ${input.repo}: ${input.title}. Its updates follow in this thread.`,
      );
      const job = await postJob(
        team,
        {
          ...selection,
          repo: input.repo,
          kind: input.kind,
          title: input.title,
          brief: input.brief,
          origin: thread ? { ...thread, ...(asker ? { asker } : {}) } : undefined,
          priority: input.priority,
          secrets: input.secrets,
          ...(continues ? { continues } : {}),
        },
        files,
      );
      await launchNow();
      return {
        job: `#${job.ref}`,
        state: job.state,
        runsOn: job.runsOn,
        secrets: job.secrets,
        reportsTo: reportsTo(job.origin, here),
        ...(continues ? { continues: `#${continues.number} (${continues.branch})` } : {}),
        ...(files.length ? { files: files.map((file) => file.name) } : {}),
      };
    },
  });
});
