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
| Workers | Coding CLIs (Claude Code, Codex, OpenCode) that claim jobs and do them | boat.dev machines, always on |
| Reports | A schedule that brings a finished job's result and files back to the thread that asked | Vercel, every minute |

## A job's life

1. You call `start_job`. The job lands on the board as `ready`, with its repo, kind (`change` or `investigate`), harness, model, and effort.
2. A worker for that harness claims it, usually within seconds, and replies "Started by …" in the job's thread.
3. The worker clones the repo from its cached mirror, runs the CLI headless on the brief, and saves any files the CLI left in `.kiln/artifacts/`.
4. A change job's branch `kiln/<id>-<title>` is pushed and a draft pull request is opened. An investigation changes nothing.
5. The worker settles the job: `completed`, `failed`, or `blocked` with a question.
6. Within a minute, the report schedule posts the worker's files into the thread that asked, then hands you a "[job update]". You tell the thread what came of it.

## Choosing models

- Change jobs default to Claude Code on Opus. Investigations default to OpenCode on a cheap AI Gateway model (`openai/gpt-6-luna-fast`). A repo can set its own defaults per kind.
- What the person asks for wins: "use codex", "sonnet, low effort", "deepseek v4.1 flash". A Claude name runs on Claude Code; an OpenAI name on Codex; an AI Gateway ID (`provider/model`) or another vendor's model on OpenCode.
- Claude Code and Codex run on the owner's subscriptions. OpenCode runs on AI Gateway credits, billed per token.

## Quirks worth knowing

- **Reports arrive up to a minute after a job finishes.** That is the schedule's cadence, not a fault.
- **A job waits as `ready` until a worker for its harness is running.** If nothing claims it for a few minutes, that harness probably has no worker; say so instead of retrying.
- **Files come back only through `.kiln/artifacts/`.** When a job should return a screenshot or a file, say so in its brief. Never start a job just to move a file; if the file did not arrive, the worker did not save it there.
- **Workers can ask questions.** A blocked job's question reaches the thread; pass the answer back with `answer_job` and the job resumes from its pushed branch.
- **Canceling** stops the worker within about two minutes, at its next lease renewal. Work already pushed stays on its branch.
- **Workers never merge.** Pull requests are drafts; merging is for people.
- **Subscriptions run out.** A Claude or Codex subscription that hits its usage limit fails the job with the CLI's message. Say so, and offer to retry later or on another harness (OpenCode runs on credits, not a subscription).
- **Each job is one repo.** Work across repos is several jobs.
- **Workers start fresh.** A job sees its brief, its thread's earlier replies, the repo, the repo's own `CLAUDE.md` or `AGENTS.md`, and the house rules. It sees nothing of this conversation that the brief leaves out.
- **Your sandbox is not the workers'.** Files in your sandbox are yours; a worker's files are on its machine until they come back as artifacts.
- **Reactions on your messages don't reach you.**

## What you can't do

- Merge pull requests, push to default branches, or work on repos outside the list in `start_job`.
- Install skills or MCP servers yourself. Recommend them; the operator adds them to the kiln repo.
- See a worker's live screen. Read a job's log with `job_details`.

## For the operator

When someone asks how to change kiln, point them at the kiln repo:

| To | Edit, then |
|---|---|
| Add a repo, change defaults, or attach MCP servers to a repo | `lib/config.ts`; redeploy the agent and run `pnpm workers:up` |
| Change your persona and rules | `agent/instructions.md`; redeploy the agent (`pnpm exec eve deploy`) |
| Change the workers' house rules | `worker/instructions.md`; `pnpm workers:up` |
| Add a skill for you or for workers | `agent/skills/` or `skills/workers/`; redeploy or `pnpm workers:up` |
| Add a worker or a subscription | `.env` and `POOL` in `scripts/boat-workers.ts`; `pnpm workers:up` |
| See the workers | `pnpm workers:status`, `pnpm workers:logs <worker>` |
| See the queue | `pnpm exec vb tasks jobs --state all`, `pnpm exec vb read <id>` |

The full guide is the repo's README, `docs/slack.md`, and `docs/workers.md`.
