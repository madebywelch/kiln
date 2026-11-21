# kiln

robdog: an AI teammate in Slack that thinks through ideas with you and hands work on your repos to a pool of coding agents running on your own subscriptions.

```
Slack ──> robdog (eve on Vercel) ──start_job──> Vercel Board  "jobs"  <──claim── workers (boat.dev machines)
  ^          │  memory, tools, MCP                    │                            claude-1..3  Claude Code
  │          │                                        │ report=pending              codex-1      Codex CLI
  └──────────┴──── job-reports schedule (every minute) ┘                            opencode-1   AI Gateway models
                                                                                        clone, branch, run, push, draft PR
```

- **robdog** is an [eve](https://vercel.com/docs/eve) agent deployed to Vercel. It hears Slack, keeps one shared memory, and decides when to speak, react, or start a job.
- **Vercel Board** holds the jobs. A job is a task in the `jobs` channel: the brief in its text, everything a worker routes and runs on in its labels.
- **Workers** are boat.dev machines, one per subscription or key. Each claims jobs for its harness, does the work in a fresh clone, opens a draft pull request, and settles the task.
- **Reports** flow back through the board: a worker marks a settled job `report=pending`, and robdog's `job-reports` schedule hands it to the Slack thread that asked, once.

## What robdog does in Slack

| | |
|---|---|
| Hears | DMs, @mentions, its name, replies in threads it is part of, and every other message in channels it is in. A cheap decision model screens out what clearly needs nothing from it; robdog judges the rest and usually stays quiet. |
| Sees | The channel's recent messages when a new thread of talk starts, each thread's earlier replies, sender names, attached files, and its shared memory. `slack_history` reads any channel or thread it is in. |
| Says | Replies in the thread, top-level posts in the channel (`slack_post`), new threads, Block Kit layouts, emoji reactions (`slack_react`), and files (`slack_upload`). Tool approvals and questions appear as buttons. |
| Does | Starts, lists, inspects, cancels, and answers jobs. Searches and reads the web. Runs code in its own sandbox. |

Setup: [docs/slack.md](docs/slack.md).

## Repos and defaults

Workers touch only the repos in [lib/config.ts](lib/config.ts). Each has a description robdog uses to map conversation to a repo, so talk about several projects can share a channel. Add your repos there; the agent and the workers both read it, so redeploy the agent and run `pnpm workers:up` after a change.

```ts
export const repos = {
  "player.games-app": {
    github: "madebywelch/player.games-app",
    description: "Player Games, the player.games website: ...",
    // baseBranch: "main",
    // defaults: { change: { harness: "codex", model: "gpt-5.5", effort: "xhigh" } },
    // mcp: ["linear"],
  },
};
// A cheap model reads, a heavy one writes.
export const defaultSelection = {
  change: { harness: "claude", model: "opus", effort: "high" },
  investigate: { harness: "opencode", model: "openai/gpt-6-luna-fast", effort: "medium" },
};
```

## Choosing the model and effort

Say it in Slack, or don't:

| You say | The job runs on |
|---|---|
| "add a christmas theme to the player games site" | a change: the repo's default, else `claude opus/high` |
| "figure out why CI is slow" | an investigation: the repo's default, else `opencode openai/gpt-6-luna-fast/medium` |
| "use codex for this" | `codex` with its CLI default model |
| "sonnet, low effort" | `claude sonnet/low` |
| "deepseek v4.1 flash" | `opencode deepseek/deepseek-v4.1-flash`: any AI Gateway model runs on OpenCode |
| "gpt-5.5 at max" | `codex gpt-5.5/xhigh` (Codex's top effort) |

Field by field, what you ask for wins over the repo's defaults for that kind of job, which win over the global ones. A model picks its harness: a Claude name runs on Claude Code, an OpenAI name on Codex, and an AI Gateway ID (`provider/model`) or another vendor's model on OpenCode. A harness named alone gets its own default model. The resolution is `resolveSelection` in [lib/jobs.ts](lib/jobs.ts), tested in [test/jobs.test.ts](test/jobs.test.ts).

## Skills and prompts

| | robdog (Slack) | Workers |
|---|---|---|
| Prompt | [agent/instructions.md](agent/instructions.md) | [worker/instructions.md](worker/instructions.md), plus each repo's own `CLAUDE.md` or `AGENTS.md` |
| Skills | [agent/skills/](agent/skills): grilling, grill-with-docs, domain-modeling, teach, find-skills | [skills/workers/](skills/workers): agent-browser, ui-taste, domain-modeling, vercel-react-best-practices |

Third-party skills are vendored unmodified under their own licenses (MIT or Apache-2.0); [skills/vendor.json](skills/vendor.json) records each one's source, hash, and license, and [skills/LICENSES/](skills/LICENSES) holds the texts. To add one, run `npx skills add <source> --skill <name> --copy` in a scratch directory, read it, and copy it into the right folder. A skill for one repo belongs in that repo's `.claude/skills/`.

## Jobs

- **change** jobs commit to `robdog/<id>-<title>`, push it, and open a draft pull request. Workers never merge.
- **investigate** jobs report findings and change nothing.
- A harness that cannot go on without a person ends with `QUESTION: ...`. The worker pushes its work and blocks the task; robdog asks in the thread and passes the answer back with `answer_job`; the next worker resumes from the branch.
- A worker that stops (an update, a crash, `boat stop`) hands its job back to the queue. A worker that loses its claim (lease expired, job canceled) stops the harness without settling.

Watch the queue:

```sh
npx vb tasks jobs --state all     # every job and its state
npx vb read <id>                  # one job's thread: brief, progress, report
npx vb inspect                    # the board's UI, served from your machine
```

## Set it up

1. **Agent.** `pnpm install`, then `pnpm exec eve link` to create or link the Vercel project. Vercel Pro: the report schedule runs every minute, and Hobby allows one run per 15 minutes.
2. **Memory.** `pnpm exec eve integration setup file-memory` provisions a private Blob store for robdog's memory.
3. **Board.** A team's default grants already let every project read, post, and label. If yours were narrowed, grant robdog's project: `pnpm exec vb grants create --project <project> --environment production --can 'jobs=read,post,label'`. Without a grant robdog's job tools fail with `404 no_board`.
4. **Slack.** Create the app from the manifest in [docs/slack.md](docs/slack.md) and set `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` on the project.
5. **Deploy.** `pnpm exec eve deploy`.
6. **Workers.** [docs/workers.md](docs/workers.md).

| Agent setting | Default | |
|---|---|---|
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | required | The Slack app's credentials. Or `SLACK_CONNECTOR`, a Vercel Connect connector UID, instead of both. |
| `ROBDOG_MODEL` | `anthropic/claude-opus-5.5` | robdog's own model: an AI Gateway model ID, which needs no key on Vercel. |
| `ROBDOG_MODEL_URL`, `ROBDOG_MODEL_KEY` | unset | Use any OpenAI-compatible endpoint instead of AI Gateway, such as OpenRouter. `ROBDOG_MODEL` is then that endpoint's model name. |

## MCP servers, APIs, and GitHub

- **Workers** carry `git`, `gh` (with `GH_TOKEN`), and the MCP servers their repo lists. Define a server once in `mcpServers` in `lib/config.ts`, name it in a repo's `mcp`, and put any secret it needs in `.env.mcp`. See [docs/workers.md](docs/workers.md#skills-house-rules-and-mcp).
- **robdog** reaches an MCP server or an OpenAPI service through a file in `agent/connections/`. See [eve connections](https://vercel.com/docs/eve).

## Trust

- Anyone in the Slack workspace can talk to robdog and start jobs. robdog has one memory for everyone. Restrict it in `agent/channels/slack.ts` (an allowlist in `onMessage`) and scope `agent/memory.ts` if the workspace stops being private.
- What other people say reaches the model as conversation, and the instructions tell it so. That is a soft boundary.
- Workers run their CLIs with permission prompts off, each alone on its own boat machine. The worker holds a GitHub token that can push to the listed repos; the CLI does not get it. Protect each repo's default branch: workers push only `robdog/*` branches, and nothing stops a harness from trying otherwise except that token's reach and branch protection.
- Board text is instructions to whoever claims it. Workers take jobs only from robdog's actor (`ROBDOG_BOARD_FROM`).

## Development

```sh
pnpm check        # biome, tsc, vitest
pnpm build        # eve build
pnpm dev          # robdog locally, with eve's terminal UI
```

Tests run without network or keys. Worker tests drive real git and a real Board (in memory, and over HTTP with `vb serve`) with fake coding CLIs. Slack tools run against a fake Web API.

Evals drive robdog's real model and spend tokens. Run them after changing instructions or tool descriptions, on more than one vendor:

```sh
ROBDOG_MODEL_URL=https://openrouter.ai/api/v1 ROBDOG_MODEL_KEY=$OPENROUTER_API_KEY \
  ROBDOG_MODEL=anthropic/claude-sonnet-5.5 pnpm eval
```

## Limits

- Board is experimental. Its API and limits may change.
- A job's result reaches Slack within a minute of settling, not at once.
- Reactions people put on robdog's messages don't reach it.
- Jobs run on one repo each. Work across repos is several jobs.
- Each worker runs one job at a time. Four machines, four jobs at once.
- A subscription's usage limit fails the job with the CLI's message; robdog reports it, and you retry later or on another harness.
- Antigravity has no headless CLI to drive yet. A new harness is an entry in `HARNESSES`, a case in `worker/harness.ts`, and a worker in `POOL`.
