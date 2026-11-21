# kiln

kiln runs an AI teammate in Slack. It thinks through ideas with you, keeps one memory across every channel and DM, and hands work on your repos to coding agents running on your own subscriptions and keys. Mine is called robdog.

```
Slack ──> agent (eve on Vercel) ──start_job──> Vercel Board "jobs" <──claim── workers (boat.dev machines)
  ^          memory, skills, tools                    │                         kiln-claude-1    Claude Code
  │                                                   │ report=pending          kiln-opencode-1  AI Gateway models
  └───── job-reports schedule, every minute ──────────┘                         clone, run, push, draft PR, files
```

- **The agent** is an [eve](https://vercel.com/docs/eve) agent on Vercel. It hears Slack, decides when to speak, react, or start a job, and follows the jobs it starts.
- **Jobs** are tasks on a [Vercel Board](https://vercel.com/docs/board): the brief in the text; repo, kind, harness, model, and effort in the labels.
- **Workers** are always-on [boat.dev](https://boat.dev) machines, one per subscription or key. A worker claims a job for its harness, runs the coding CLI headless in a fresh clone, pushes a branch and opens a draft PR for a change, attaches any files the CLI saved, and settles the job.
- **Reports** come back through the board. Within a minute of a job settling, the agent's schedule posts the worker's files into the Slack thread that asked and hands the agent the result to relay.

## What the agent does in Slack

| | |
|---|---|
| Hears | DMs, @mentions, its name, replies in threads it is part of, and other messages in channels it is in. A cheap decision model screens out what clearly needs nothing from it; the agent judges the rest and usually stays quiet. |
| Sees | The channel's recent messages when a new thread starts, each thread's earlier replies, sender names, attached files, and its memory. |
| Says | Thread replies, top-level posts, new threads, Block Kit, emoji reactions, and files. Approvals and questions appear as buttons. |
| Does | Starts, lists, inspects, cancels, and answers jobs. Searches the web. Runs code in its own sandbox. Explains how kiln works, from its `kiln` skill. |

## Jobs and models

- **change** jobs commit to `kiln/<id>-<title>`, push it, and open a draft PR. Workers never merge.
- **investigate** jobs report findings and change nothing.
- **Files** a job's CLI saves in `.kiln/artifacts/`, such as screenshots, are posted into the Slack thread with the report. They are never committed.
- **Questions:** a CLI that needs a person ends with `QUESTION: ...`. The worker pushes its work and blocks the job; the agent asks in the thread, passes the answer back, and the next run resumes from the branch.

Say the model in Slack, or don't:

| You say | The job runs on |
|---|---|
| "add a christmas theme to the player games site" | a change: the repo's default, else `claude opus/high` |
| "figure out why CI is slow" | an investigation: the repo's default, else `opencode openai/gpt-6-luna-fast/medium` |
| "sonnet, low effort" | `claude sonnet/low` |
| "deepseek v4.1 flash" | `opencode deepseek/deepseek-v4.1-flash`: any AI Gateway model runs on OpenCode |
| "use codex" | `codex` with its CLI's default model |

What you ask for wins over the repo's defaults for that kind of job, which win over the global ones. A Claude name runs on Claude Code, an OpenAI name on Codex, and an AI Gateway ID (`provider/model`) or another vendor's model on OpenCode.

## Configure it

| To change | Edit | Then |
|---|---|---|
| The agent's name | `agent.name` in [lib/config.ts](lib/config.ts), its persona, and its Slack app | redeploy; a new name starts a fresh memory |
| Repos, defaults, and per-repo MCP servers | [lib/config.ts](lib/config.ts) | redeploy and `pnpm workers:up` |
| The agent's persona and rules | [agent/instructions.md](agent/instructions.md) | `pnpm exec eve deploy` |
| The agent's skills | [agent/skills/](agent/skills) | `pnpm exec eve deploy` |
| The workers' house rules | [worker/instructions.md](worker/instructions.md) | `pnpm workers:up` |
| The workers' skills | [skills/workers/](skills/workers) | `pnpm workers:up` |
| Workers and their subscriptions | `.env` and `POOL` in [scripts/boat-workers.ts](scripts/boat-workers.ts) | `pnpm workers:up` |

Third-party skills are vendored unmodified under their own licenses; [skills/vendor.json](skills/vendor.json) records each one's source, hash, and license, and [skills/LICENSES/](skills/LICENSES) holds the texts. A skill for one repo belongs in that repo's `.claude/skills/`.

## Set it up

1. **Agent.** `pnpm install`, then `pnpm exec eve link`. Use Vercel Pro: the report schedule runs every minute, and Hobby allows one run per 15 minutes.
2. **Memory.** `pnpm exec eve integration setup file-memory`.
3. **Board.** A team's default grants let every project read, post, and label. If yours were narrowed: `pnpm exec vb grants create --project <project> --environment production --can 'jobs=read,post,label'`.
4. **Slack.** Create the app from the manifest in [docs/slack.md](docs/slack.md), then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` on the Vercel project.
5. **Deploy.** `pnpm exec eve deploy`.
6. **Workers.** Fill in `.env` and run `pnpm workers:up`; see [docs/workers.md](docs/workers.md).

| Agent setting | Default | |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | required | The Slack app's credentials, or `SLACK_CONNECTOR` for a Vercel Connect connector. |
| `KILN_MODEL` | `anthropic/claude-opus-5.5` | The agent's own model, an AI Gateway ID. No key is needed on Vercel. |
| `KILN_MODEL_URL`, `KILN_MODEL_KEY` | unset | Any OpenAI-compatible endpoint instead of AI Gateway, such as OpenRouter. |

## Operate it

```sh
pnpm workers:status              # each worker's machine, service, and last log line
pnpm workers:logs claude-1       # one worker's recent log
pnpm exec vb tasks jobs --state all
pnpm exec vb read <job id>       # a job's brief, progress, report, and files
pnpm exec vb inspect             # the board's UI, served from your machine
```

## Trust

- Anyone in the Slack workspace can talk to the agent and start jobs, and it has one memory for everyone. Restrict senders in `agent/channels/slack.ts` and scope `agent/memory.ts` if the workspace stops being private.
- Other people's messages reach the model as conversation, and its instructions say so. That is a soft boundary.
- Coding CLIs run with permission prompts off, alone on their machines, without the worker's GitHub or Board credentials. Protect each repo's default branch: workers push only `kiln/*` branches.
- Workers take jobs only from the agent's board actor (`KILN_BOARD_FROM`).

## Develop it

```sh
pnpm check        # biome, tsc, vitest; no network or keys needed
pnpm build        # eve build
pnpm dev          # the agent locally, in eve's terminal UI
pnpm eval         # the agent's real model on scripted conversations; spends tokens
```

| Path | What it is |
|---|---|
| `agent/` | The eve agent: instructions, Slack channel, tools, skills, memory, the report schedule |
| `lib/` | Shared by agent and workers: config, the job contract, Board operations |
| `worker/` | The worker: claim loop, one job's run, harness adapters, skill sync, house rules |
| `skills/workers/` | Skills installed into every worker's coding CLIs |
| `scripts/boat-workers.ts` | Provisions and updates the worker machines on boat.dev |
| `evals/`, `test/` | Model evals and the test suite |
| `docs/` | Slack and worker setup |

## Limits

- Board is experimental; its API and limits may change.
- A job's result reaches Slack within a minute of settling.
- Each worker runs one job at a time.
- A subscription's usage limit fails the job with the CLI's message.
- Reactions on the agent's messages don't reach it.
- One repo per job.
