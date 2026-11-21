import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { postJob } from "../../lib/board-jobs.ts";
import { defaultSelection, EFFORTS, HARNESSES } from "../../lib/config.ts";
import { configuredRepos } from "../../lib/deployment.ts";
import {
  describeSelection,
  KINDS,
  MAX_BRIEF_CHARS,
  MAX_TITLE_CHARS,
  resolveSelection,
} from "../../lib/jobs.ts";
import { team } from "../lib/board.ts";
import { launchNow } from "../lib/machines.ts";
import { slackHere } from "../lib/slack.ts";

// Built per model call from kiln.config.yaml (KILN_CONFIG), so the public code names no repos.
// With none configured, the tool isn't offered.
export default defineDynamic(() => {
  const repos = configuredRepos();
  if (!repos) return null;
  const repoKeys = Object.keys(repos) as [string, ...string[]];
  const repoLines = Object.entries(repos).map(([key, repo]) => {
    const own = Object.entries(repo.defaults ?? {})
      .map(
        ([kind, d]) =>
          `${kind}: ${describeSelection({ ...defaultSelection[kind as keyof typeof defaultSelection], ...d })}`,
      )
      .join(", ");
    return `- ${key}: ${repo.description}${own ? ` (defaults: ${own})` : ""}`;
  });

  return defineTool({
    description: [
      "Hand work on a repo to the worker pool, each job in a fresh clone. A change job commits to its own",
      "branch and opens a draft pull request; an investigate job only reports. The result comes back to this",
      "thread when the job settles.",
      "",
      "Repos:",
      ...repoLines,
      "",
      "Harnesses: claude (Claude Code on a subscription: opus, sonnet, haiku), codex (Codex on a subscription:",
      "gpt-5.5 and other OpenAI names), opencode (any AI Gateway model ID, billed per token: openai/gpt-6-luna-fast,",
      "deepseek/deepseek-v4.1-flash, google/gemini-3-flash, anthropic/claude-opus-5.5).",
      "",
      `Unless the user names them: change jobs run on ${describeSelection(defaultSelection.change)}, investigate jobs on ${describeSelection(defaultSelection.investigate)}.`,
      'Pass harness, model, or effort only when the user asked for them ("use codex", "opus at max effort", "deepseek for this").',
      "For opencode, pass the full AI Gateway ID. Naming only a harness gets its default model.",
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
      harness: z.enum(HARNESSES).optional(),
      model: z
        .string()
        .optional()
        .describe("The harness CLI's model name or alias, e.g. opus, sonnet, gpt-5.5."),
      effort: z.enum(EFFORTS).optional(),
    }),
    label: { start: ({ repo, title }) => `Start job on ${repo}: ${title}` },
    async execute(input, ctx) {
      const selection = resolveSelection(input.repo, input.kind, input, repos);
      const here = slackHere(ctx);
      const job = await postJob(team, {
        ...selection,
        repo: input.repo,
        kind: input.kind,
        title: input.title,
        brief: input.brief,
        origin: here?.threadTs ? { channelId: here.channelId, threadTs: here.threadTs } : undefined,
      });
      await launchNow();
      return {
        id: job.id,
        state: job.state,
        runsOn: job.runsOn,
        reportsTo: job.origin ? "this thread" : "nowhere",
      };
    },
  });
});
