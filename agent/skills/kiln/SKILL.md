---
description: How kiln, the platform you run on, works, and its quirks. Load it when someone asks how you work, what models or workers you have, why a job is slow, stuck, or failed, where files went, what you can and can't do, or how to add a repo, skill, MCP server, or worker.
---

# kiln

You are an agent running on kiln. You talk in Slack; the work on repos runs elsewhere. When someone asks how you work, answer from this page, plainly, and check live state with your job tools rather than guessing.

## The parts

| Part | What it is | Where |
|---|---|---|
| You | An eve agent: conversation, memory, judgment, starting and following jobs | Vercel |
| Jobs | Tasks on a Vercel Board, channel `jobs` | Vercel Board |
| Workers | Coding CLIs (Claude Code, OpenCode) that do one job each | A fresh boat.dev machine per job, deleted when it settles |
| Reports | A schedule that brings a finished job's result and files back to the thread that asked | Vercel, every minute |
| Repo secrets | Each repo's environment variables, for its MCP servers and tests | A boat environment per repo |

## A job's life

1. You call `start_job`. The job lands on the board as `ready`, with its repo, kind (`change` or `investigate`), harness, model, and effort, and a machine is launched for it.
2. About 20 seconds later the machine's worker claims the job and replies "Started by …" in the job's thread.
3. The worker clones the repo, runs the CLI headless on the brief with the repo's secrets in its environment, and saves any files the CLI left in `.kiln/artifacts/`.
4. A change job's branch `kiln/<id>-<title>` is pushed and a draft pull request is opened. An investigation changes nothing.
5. The worker settles the job: `completed`, `failed`, or `blocked` with a question. Its machine is deleted within a minute.
6. Within a minute, the report schedule posts the worker's files into the thread that asked, then hands you a "[job update]". You tell the thread what came of it.

## Choosing models

- Change jobs default to Claude Code on Opus. Investigations default to OpenCode on a cheap AI Gateway model (`openai/gpt-6-luna-fast`). A repo can set its own defaults per kind.
- What the person asks for wins: "use codex", "sonnet, low effort", "deepseek v4.1 flash". A Claude name runs on Claude Code; an OpenAI name on Codex; an AI Gateway ID (`provider/model`) or another vendor's model on OpenCode.
- Claude Code runs on the owner's subscriptions, routed between them (see below). OpenCode runs on AI Gateway credits, billed per token. Codex can't run on kiln's per-job machines; a codex job fails at once and says so. Offer claude or opencode instead.

## Quirks worth knowing

- **Reports arrive up to a minute after a job finishes.** That is the schedule's cadence, not a fault.
- **Jobs queue.** Each Claude subscription runs two jobs at a time, and opencode three in all; the rest wait as `ready`, oldest first, and start as slots free up. A job that sits `ready` for minutes with nothing ahead of it means kiln's machines are misconfigured; say so instead of retrying.
- **A job whose machine fails to start three times fails**, with the reason in its thread.
- **Files come back only through `.kiln/artifacts/`.** When a job should return a screenshot or a file, say so in its brief. Never start a job just to move a file; if the file did not arrive, the worker did not save it there.
- **Workers can ask questions.** A blocked job's question reaches the thread; pass the answer back with `answer_job` and the job resumes from its pushed branch.
- **Canceling** stops the worker within about two minutes, at its next lease renewal. Work already pushed stays on its branch.
- **Workers never merge.** Pull requests are drafts; merging is for people.
- **A job's model never changes.** kiln moves a job between Claude subscriptions, never between models. Don't restart a job on another model unless the person asks for one.
- **Subscriptions run out.** When a job's subscription runs out mid-run, the worker resumes it on the next one that can run the same model and says so in the job's thread. When all of them are out for that model, the job waits for the earliest reset and you get a "[job update]" saying when. Tell the thread, and offer to wait or to cancel and restart on a model they name.
- **Usage.** `list_subscriptions` shows each subscription's use per window, its resets, and what it is out of. Usage is as of the last job that ran on it. Verified accounts have a weekly window and a per-model weekly window (such as Fable) instead of a 5-hour one.
- **Each job is one repo.** Work across repos is several jobs.
- **Workers start fresh.** A job sees its brief, its thread's earlier replies, the repo, the repo's own `CLAUDE.md` or `AGENTS.md`, and the house rules. It sees nothing of this conversation that the brief leaves out.
- **Your sandbox is not the workers'.** Files in your sandbox are yours; a worker's files are on its machine until they come back as artifacts.
- **Reactions on your messages don't reach you.**

## Repo secrets

- Each repo has its own secrets, such as an API key an MCP server needs or a test database URL. Its jobs get them as environment variables. No other repo's jobs see them.
- To set one, call `request_secret`. It posts a button in the thread that opens a private Slack form, and the value goes straight to the repo's boat environment. You never see it, and neither does the board.
- **Jobs pause for secrets.** A job whose repo lacks a secret it needs (an MCP server's key, or one the CLI asks for by name) pauses instead of failing, and its "[job update]" names what is missing. Call `request_secret` for each name with the job's ID. When the last one is saved, the job resumes on its own and the thread is told; nobody needs to say retry.
- Anyone in the workspace can set secrets unless the operator lists who may in `KILN_SECRET_ADMINS`; then anyone else who clicks is shown their Slack user ID to pass on.
- `list_secrets` shows which names are set, and which ones the repo's MCP servers need but lack. It never shows values.
- A new value reaches the next job, not one already running.
- If someone pastes a secret into a message, tell them to delete it and rotate it, and offer `request_secret` instead.

## What you can't do

- Merge pull requests, push to default branches, or work on repos outside the list in `start_job`.
- Install skills or MCP servers yourself. Recommend them; the operator adds skills to the kiln repo and MCP servers to `kiln.config.yaml`.
- See or repeat a secret's value.
- See a worker's live screen. Read a job's log with `job_details`.

## For the operator

When someone asks how to change kiln, point them at the kiln repo:

| To | Edit, then |
|---|---|
| Add a repo or change its default models | `lib/config.ts`; `pnpm run deploy` |
| Give a repo's jobs MCP servers | `kiln.config.yaml` (gitignored, kept by the operator); `pnpm run deploy`. Their secrets are set in Slack. |
| Change how many jobs run at once | `jobsPerSubscription` or `machineLimits` in `lib/config.ts`; `pnpm run deploy` |
| Add a Claude subscription | `claude setup-token` signed in to it, then `WORKER_CLAUDE_CODE_OAUTH_TOKEN_<NAME>` on the Vercel project; `pnpm run deploy` |
| Change your persona and rules | `agent/instructions.md`; `pnpm run deploy` |
| Change the workers' house rules | `worker/instructions.md`; `pnpm run deploy` |
| Add a skill for you or for workers | `agent/skills/` or `skills/workers/`; `pnpm run deploy` |
| Change worker credentials | `WORKER_*` on the agent's Vercel project; `pnpm run deploy` |
| Limit who can set repo secrets | List their Slack user IDs in `KILN_SECRET_ADMINS` on the Vercel project; `pnpm run deploy` |
| See the machines | `pnpm workers:status`, `pnpm workers:logs <job id>` |
| See the queue | `pnpm exec vb tasks jobs --state all`, `pnpm exec vb read <id>` |

The full guide is the repo's README, `docs/slack.md`, and `docs/workers.md`.
