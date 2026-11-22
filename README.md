# kiln

kiln runs an AI teammate in Slack. It thinks through ideas with you, keeps one drive of notes and files across every channel and DM, and hands work on your repos to coding agents running on your own subscriptions and keys. You name it; out of the box it is eve.

```
Slack ──> agent (eve on Vercel) ──start_job──> Vercel Board "jobs" <──claim── one boat.dev machine per job
  ^          drive, skills, tools   │                 │                         Claude Code on your subscriptions
  │                                 └─ launches ──────┼───────────────────────> the repo's secrets only
  │                                                   │ report=pending          clone, run, push, draft PR, files
  └───── job-reports schedule, every minute ──────────┘                         deleted when the job settles
```

- **The agent** is an [eve](https://vercel.com/docs/eve) agent on Vercel. It hears Slack, decides when to speak, react, or start a job, and follows the jobs it starts.
- **Jobs** are tasks on a [Vercel Board](https://vercel.com/docs/board): the brief in the text; repo, kind, harness, model, and effort in the labels.
- **Workers** run on [boat.dev](https://boat.dev) machines, a fresh one per job, launched by the agent when it starts the job and deleted when the job settles. With no jobs there are no machines. A worker claims its job, runs the coding CLI headless in a fresh clone, pushes a branch and opens a draft PR for a change, attaches any files the CLI saved, and settles the job.
- **Repo secrets** live in a boat environment per repo. A job's machine gets its own repo's secrets and nothing else. People set them through a Slack form the agent never sees.
- **Reports** come back through the board. Within a minute of a job settling, the agent's schedule posts the worker's files into the Slack thread that asked and hands the agent the result to relay.

## What the agent does in Slack

| | |
|---|---|
| Hears | DMs, @mentions, its name, replies in threads it is part of, and other messages in channels it is in. A cheap decision model screens out what clearly needs nothing from it; the agent judges the rest and usually stays quiet. |
| Sees | The channel's name, the channel's recent messages when a new thread starts, each thread's earlier replies, sender names, attached files, and its drive's `AGENTS.md`. |
| Says | Thread replies, top-level posts, new threads, Block Kit, emoji reactions, and files. Approvals and questions appear as buttons. |
| Does | Starts, lists, inspects, cancels, and answers jobs. Schedules tasks for later or on a repeat ("every weekday at 9am Eastern"), which come back to it in the thread. Asks for repo secrets with a button and a private form. Searches the web. Runs code in its own sandbox. Explains how kiln works, from its `kiln` skill. |

## The drive

The drive is the agent's only memory: a folder of files it organizes however it likes, in a private Vercel Blob store under `kiln/drive/`. It is kiln's own, not eve's, so it survives a move off eve.

- **`AGENTS.md`** is the agent's whole standing prompt, sent as its system prompt every turn (up to 24,000 characters): who it is, how it talks and when it speaks, how it runs jobs, what it can do, the people it works with, and standing decisions. kiln keeps no other prompt in code. It is always there and can't be removed, moved, or renamed. The agent edits it a line at a time with `drive_edit`, and changes its rules only when someone asks it to; you can edit it too, in the Blob store. Every change keeps the previous version in `.history/`. kiln writes the starter version ([lib/agents-starter.ts](lib/agents-starter.ts)) only when the drive has none, and falls back to it if the drive can't be read (`drive.prompt_failed` in the logs).
- **Everything else** the agent reads when it looks, with `drive_list`, `drive_search`, and `drive_read`. There is no required structure.
- It reads what it keeps on a topic before working on it, and writes what is worth keeping before it ends a turn. It can search the drive, save Slack attachments into it, and post files from it.

## Jobs and models

- **change** jobs commit to `kiln/<id>-<title>`, push it, and open a draft PR. Workers never merge; the agent can, with `gh`, when you ask it to.
- **Projects** group repos that change together, such as an app and its hosted service. A job on a project clones all of its repos side by side, works across them, and opens a draft PR in each repo it changed. Projects, like repos, have their own defaults, MCP servers, and secrets.
- **investigate** jobs report findings and change nothing.
- **Files go both ways.** Drop a file in Slack and the agent keeps it in its drive, works on it in its sandbox (ImageMagick, zip, Python), or hands it to a job: the worker finds it in `.kiln/inputs/`, and it lands in the repo only where the brief says. Files a job's CLI saves in `.kiln/artifacts/`, such as screenshots, come back posted in the Slack thread and saved in the drive under `jobs/<id>/`. They ride on the job's Board task as attachments, never signed URLs, and workers never get drive access. Up to 10 files of 25 MB each way.
- **Questions:** a CLI that needs a person ends with `QUESTION: ...`. The worker pushes its work and blocks the job; the agent asks in the thread, passes the answer back, and the next run resumes from the branch.
- **Secrets:** a job whose repo lacks a secret it needs pauses. That includes an MCP server's key, or a credential the CLI asks for by name with `SECRET: NAME`. The agent posts a button for it, and saving the value in the private form resumes the job.

Say the model in Slack, or don't:

| You say | The job runs on |
|---|---|
| "add a christmas theme to the website" | a change: the repo's default, else `claude opus/high`, the implementer |
| "figure out why CI is slow" | an investigation: the repo's default, else `claude sonnet/high`, the researcher |
| "opus at max effort" | `claude opus/max` |
| "deepseek v4.1 flash" | nothing: the agent says per-token models are off and offers a subscription model |

**Workers run on subscriptions only.** `enabledHarnesses` in [lib/config.ts](lib/config.ts) lists the coding CLIs workers may use, and out of the box that is Claude Code alone. OpenCode, which runs AI Gateway models billed per token, is built in but switched off. Codex joins once its ChatGPT login can be lent to per-job machines. The agent itself runs on AI Gateway (`KILN_MODEL`), which is the only per-token spend.

**Or on your own endpoint.** Set `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` to an Anthropic-compatible endpoint and both the agent and the workers' Claude Code use it: no AI Gateway for the agent's model, no subscriptions for jobs. The cheap model that screens channel messages and voice-note transcription stay on AI Gateway.

What you ask for wins over the repo's defaults for that kind of job, which win over the global ones. Once a job starts, its harness and model are fixed.

**Subscriptions.** Give kiln several Claude subscriptions and it routes between them. A job sticks to one subscription, keeping its prompt cache warm, until that subscription runs out of usage. Then the worker resumes the same session on the next subscription that can run the job's model. kiln learns each subscription's limits from what Claude Code reports, including 5-hour windows, weekly windows, and per-model weekly windows. When every subscription that can run the model is out, the job waits for the earliest reset, and the agent tells the thread so you can wait or restart it on another model.

## Configure it

| To change | Edit | Then |
|---|---|---|
| The agent's name | `name` in `kiln.config.yaml` (default `eve`), its Slack app, and the first line of its `AGENTS.md` | `pnpm run deploy`, then update `AGENTS.md`; the drive keeps its files |
| Repos, projects, their default models, and their MCP servers | `kiln.config.yaml`, gitignored; copy [kiln.config.example.yaml](kiln.config.example.yaml) | `pnpm run deploy` |
| Global default models | `defaultSelection` in [lib/config.ts](lib/config.ts) | `pnpm run deploy` |
| How many jobs run at once per subscription or harness, and machine size | `jobsPerSubscription`, `machineLimits`, and `machineType` in [lib/config.ts](lib/config.ts) | `pnpm run deploy` |
| Claude subscriptions | `WORKER_CLAUDE_CODE_OAUTH_TOKEN` and `WORKER_CLAUDE_CODE_OAUTH_TOKEN_<NAME>` on the Vercel project | `pnpm run deploy` |
| The agent's identity, rules, and what it knows about people | `AGENTS.md` in its drive (Blob, `kiln/drive/`); the starter for a new drive is [lib/agents-starter.ts](lib/agents-starter.ts) | nothing: read fresh every turn |
| The agent's skills | [agent/skills/](agent/skills) | `pnpm run deploy` |
| The workers' house rules | [worker/instructions.md](worker/instructions.md) | `pnpm run deploy` |
| The workers' skills | [skills/workers/](skills/workers) | `pnpm run deploy` |
| Worker credentials | `WORKER_*` on the Vercel project; see [docs/workers.md](docs/workers.md) | `pnpm run deploy` |
| A repo's secrets | Ask the agent in Slack | nothing: the next job gets them |

`pnpm run deploy` deploys the agent and pins the code job machines download to the same commit, so commit and push first. It also checks `kiln.config.yaml` and sends it to the Vercel project as `KILN_CONFIG`; a broken file stops the deploy before anything changes.

Third-party skills are vendored unmodified under their own licenses; [skills/vendor.json](skills/vendor.json) records each one's source, hash, and license, and [skills/LICENSES/](skills/LICENSES) holds the texts. A skill for one repo belongs in that repo's `.claude/skills/`.

## Set it up

1. **Agent.** `pnpm install`, then `pnpm exec eve link`. Use Vercel Pro: the report schedule runs every minute, and Hobby allows one run per 15 minutes.
2. **Storage.** `pnpm exec eve integration setup file-memory`. It provisions the private Blob store the drive lives in (`EVE_MEMORY_BLOB_STORE_ID`); kiln uses the store, not eve's memory.
3. **Board.** A team's default grants let every project read, post, and label. If yours were narrowed: `pnpm exec vb grants create --project <project> --environment production --can 'jobs=read,post,label'`.
4. **Slack.** Create the app from the manifest in [docs/slack.md](docs/slack.md), then set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` on the Vercel project.
5. **Repos.** `cp kiln.config.example.yaml kiln.config.yaml` and list your repos. kiln ships naming none, and the file is gitignored.
6. **Workers.** Create a boat API key and set it and the worker credentials on the Vercel project; see [docs/workers.md](docs/workers.md).
7. **Deploy.** Commit, push, and `pnpm run deploy`.

| Agent setting | Default | |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | required | The Slack app's credentials, or `SLACK_CONNECTOR` for a Vercel Connect connector. |
| `INFERENCE_BASE_URL`, `INFERENCE_API_KEY` | unset | Your own Anthropic-compatible endpoint, with or without `/v1`. When set, the agent's model runs on it instead of AI Gateway, and Claude Code jobs run on it instead of the Claude subscriptions, up to `machineLimits.claude` at once. The key goes as `x-api-key`. Set both or neither. |
| `KILN_MODEL` | `anthropic/claude-fable-5.2` | The agent's own model: an AI Gateway ID, or on your inference endpoint its model ID (default `claude-fable-5-2`). No key is needed on Vercel for AI Gateway. |
| `KILN_REASONING` | `high` | Its reasoning level: `low`, `medium`, `high`, or `xhigh`. |
| `KILN_MODEL_URL`, `KILN_MODEL_KEY` | unset | Any OpenAI-compatible endpoint instead of AI Gateway, such as OpenRouter. |
| `KILN_GH_TOKEN` | `WORKER_GH_TOKEN` | The agent's GitHub token, for `gh` in its sandbox: PRs, CI, merging. Added at the sandbox firewall; it never enters the sandbox. |
| `KILN_TRANSCRIPTION_MODEL` | `openai/gpt-4o-mini-transcribe` | The AI Gateway model that transcribes voice notes. Always AI Gateway, even with `KILN_MODEL_URL`. |
| `BOAT_API_KEY` | required for jobs | Launches and deletes job machines and writes repo secrets. |
| `WORKER_*` | required for jobs | The workers' credentials, passed to each machine without the prefix. See [docs/workers.md](docs/workers.md). |
| `KILN_WORKER_CODE` | written by `pnpm run deploy` | The kiln commit job machines run. |
| `KILN_SECRET_ADMINS` | anyone | Slack user IDs, comma-separated, allowed to set repo secrets. Unset, anyone in the workspace can. |

## Operate it

```sh
pnpm workers:status              # every job machine: harness, state, setup, age, job
pnpm workers:logs <job id>       # a running job machine's worker log
pnpm exec vb tasks jobs --state all
pnpm exec vb read <job id>       # a job's brief, progress, report, and files
pnpm exec vb inspect             # the board's UI, served from your machine
```

## Trust

- Anyone in the Slack workspace can talk to the agent and start jobs, and it has one drive for everyone. Restrict senders in `agent/channels/slack.ts` if the workspace stops being private.
- Other people's messages reach the model as conversation, and its instructions say so. That is a soft boundary.
- Coding CLIs run with permission prompts off, alone on their job's machine, without the worker's GitHub or Board credentials. Protect each repo's default branch: workers push only `kiln/*` branches.
- A job's machine has its own repo's secrets and none of another repo's, and none of your boat, GitHub, or agent logins. The coding CLI can read its repo's secrets; that is what they are for.
- Secret values go from a Slack form to boat. They never reach the agent's model, its logs, or the board. Anyone in the workspace can set them until `KILN_SECRET_ADMINS` lists who may.

## Develop it

```sh
pnpm check        # biome, tsc, vitest; no network or keys needed
pnpm build        # eve build
pnpm dev          # the agent locally, in eve's terminal UI
pnpm eval         # the agent's real model on scripted conversations; spends tokens
```

| Path | What it is |
|---|---|
| `agent/` | The eve agent: instructions, Slack channel, tools, skills, the report schedule |
| `lib/` | Shared by agent and workers: config, the job contract, Board operations |
| `worker/` | The worker: claim loop, one job's run, harness adapters, skill sync, house rules |
| `skills/workers/` | Skills installed into every worker's coding CLIs |
| `scripts/deploy.ts` | Deploys the agent and pins the job machines' code to the same commit |
| `scripts/boat-workers.ts` | Shows the job machines and their logs |
| `evals/`, `test/` | Model evals and the test suite |
| `docs/` | Slack and worker setup |

## Limits

- Board is experimental; its API and limits may change.
- A job's result reaches Slack within a minute of settling.
- A job waits about 20 seconds for its machine before it starts.
- Each Claude subscription runs two jobs at a time (`jobsPerSubscription`). Codex and OpenCode are off (`enabledHarnesses`).
- A job whose every subscription is out of usage for its model waits for the earliest reset; it never moves to another model on its own.
- Reactions on the agent's messages don't reach it.
- One repo or project per job. A project's repos are cloned side by side; each one the job changes gets its own draft PR.
