# Workers

A worker is one coding CLI on one subscription or key, on its own boat.dev machine. It claims a job from the board, clones the repo from a local mirror, runs the CLI headless on the job's model and effort, pushes a branch and opens a draft PR for a change, and settles the task. One job at a time, under systemd, until the machine is stopped.

`scripts/boat-workers.ts` runs the pool. Each worker in its `POOL` gets a small always-on machine named `kiln-<profile>`:

| Worker | Harness | Credential in `.env` |
|---|---|---|
| `claude-1`, `claude-2`, `claude-3` | Claude Code on a subscription | `CLAUDE_TOKEN_1..3`, from `claude setup-token` |
| `opencode-1` | OpenCode on AI Gateway, billed per token | `AI_GATEWAY_API_KEY` |

A worker whose credential is unset is skipped. A small machine costs $0.018 an hour, about $13 a month left on.

## Set up

1. **Settings.** In `.env` (see `.env.example`):

   | Setting | Where it comes from |
   |---|---|
   | `BOAT_API_KEY` | `boat api-key create kiln --preset full-sandbox`, or the boat dashboard. |
   | `BOARD_TOKEN` | A Vercel access token for your account, scoped to the team: <https://vercel.com/account/tokens>. |
   | `VERCEL_ORG_ID` | The team that owns robdog's project: `orgId` in `.vercel/project.json`. |
   | `KILN_BOARD_FROM` | `vercel:project:<projectId>:production`, robdog's actor. Workers take only its jobs. Add your own `vercel:user:...` to also take jobs you post with `vb`. |
   | `GH_TOKEN` | A GitHub token with Contents and Pull requests read/write on the repos in `lib/config.ts`. |
   | `CLAUDE_TOKEN_n`, `AI_GATEWAY_API_KEY` | One per worker, as above. The AI Gateway key is under AI Gateway, API keys, in the Vercel dashboard. |

2. **Start or update the pool.** It deploys the current commit, so commit first:

   ```sh
   pnpm workers:up
   pnpm workers:status
   pnpm workers:logs claude-1
   ```

   `up` creates missing machines, resumes stopped ones, uploads the code, installs dependencies, writes the worker's environment (mode 600) and its systemd unit, restarts the service, and waits for `worker.ready`. Run it again after any change to `lib/`, `worker/`, or `skills/`.

Machines are created with no auto-stop, and in boat's protected mode: none of your boat account's logins are put on them. They carry only what `up` writes.

To stop the pool: `boat stop kiln-claude-1`. A running job is handed back to the queue. `pnpm workers:up` resumes it.

## What a job does

1. Claims the oldest ready job for its harness, with a 5-minute lease it renews every 100 seconds.
2. Replies "Started by claude-1: claude opus/high on owner/repo." in the job's thread.
3. Refreshes its mirror of the repo, clones from it, and creates `kiln/<id>-<title>` from the base branch, or from that branch on the remote if an earlier run of the job pushed it.
4. Runs the CLI with the brief, the earlier replies in the job's thread, your house rules (`worker/instructions.md`), and the rules for finishing. The full output goes to `~/work/logs/<id>.log` on the machine.
5. For a change: commits anything left uncommitted, pushes the branch, and opens a draft PR with the CLI's report as its body.
6. Replies with the report, labels the job `report=pending`, and completes, fails, or blocks the task.

| Ends with | The task |
|---|---|
| The report | completed, result `Draft PR: <url>`, `No changes made.`, or the report's first line |
| `QUESTION: ...` | blocked for an answer; the work is pushed |
| A non-zero exit, a CLI error, the timeout (`JOB_TIMEOUT_MINUTES`, default 180) | failed, with the output's tail in the thread |
| The machine stopping | released, ready for the next worker |
| A lost claim | left alone; whoever holds it now settles it |

## Skills, house rules, and MCP

- **Skills** in `skills/workers/` are copied into `~/.claude/skills` (Claude Code and OpenCode) and `~/.codex/skills` (Codex) each time a worker starts. A skill for one repo belongs in that repo's own `.claude/skills/`.
- **House rules** in `worker/instructions.md` go into every job's prompt.
- **MCP servers** are defined once in `mcpServers` in `lib/config.ts`. A repo lists the ones its jobs get in its `mcp`. Values may name variables as `${NAME}`; put those secrets in `.env.mcp`, and `up` passes them to every worker.

## Codex

Codex's ChatGPT login has to be made on the machine and refreshes itself there, so it is not in `POOL` by default. To add it: add `{ profile: "codex-1", harness: "codex", secret: "CODEX_ENABLED" }` to `POOL`, set `CODEX_ENABLED=1`, run `pnpm workers:up` once (it fails on the missing login), then `boat ssh kiln-codex-1 -- codex login --device-auth`, and `pnpm workers:up` again.

## GitHub credentials

The coding CLI runs with permission prompts off, so it gets none of the worker's credentials: `GH_TOKEN` and `BOARD_TOKEN` are removed from its environment, and only the worker pushes and opens pull requests. Set `HARNESS_GH_TOKEN` to a read-only token (Actions, Contents, Pull requests, Issues: read) if jobs should read CI runs and issues with `gh`; the CLI sees it as its `GH_TOKEN`.

The CLI and the worker run as the same user, so a determined CLI can still read the worker's process environment. The hard boundary is on GitHub: protect each repo's default branch, and scope `GH_TOKEN` to the repos in `lib/config.ts`.

Planned, not built: replace the personal token with a GitHub App.

- Installation tokens last an hour and can be minted per job for one repo with only the permissions it needs: a write token for the worker's push and PR, a read token for the CLI.
- PRs come from `robdog[bot]` instead of you, so you can approve them. With a personal token you author them and can't.
- Rulesets can target the App, for example to allow it to push only `kiln/*`.
- The App's private key must sit where the CLI can't read it: a separate user on the machine, or robdog minting tokens on Vercel. In the CLI's reach, a leaked key is worse than a leaked scoped token.

## Troubleshooting

| Log | Means |
|---|---|
| `config.invalid` | A setting is missing or malformed; the field is named. `up` prints it and stops. |
| `claim.failed` with `401` or `not_logged_in` | `BOARD_TOKEN` is wrong or expired. |
| No `job.claimed` while jobs wait | No worker runs that job's harness, or `KILN_BOARD_FROM` doesn't match who posted it (`pnpm exec vb read <job id>`). |
| `job.settle_failed` with `claim_lost` | The job was canceled, or the lease ran out, while it ran. |
| A job failed with a usage-limit message | That subscription is spent for now. Retry later, or on another harness. |
