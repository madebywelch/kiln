# Workers

Every job runs on its own fresh boat.dev machine. The agent launches the machine when it starts the job and deletes it once the job settles. With no jobs, there are no machines and nothing to pay for.

## A machine's life

1. **Launch.** `start_job` posts the job and asks boat for a machine right away. A schedule on the agent checks every minute as well, so a launch that failed is retried. The machine starts in the repo's own boat environment, so it gets that repo's secrets and no other's.
2. **Setup**, about 20 seconds. The setup script downloads kiln at the commit the agent was deployed from, installs the worker's dependencies, and starts the worker. The worker reads its settings file (`~/.kiln/worker.json`, mode 600) into its environment and deletes it.
3. **The job.** The worker claims its job by ID, with a 5-minute lease it renews every 100 seconds. It replies "Started by claude: claude opus/high on owner/repo." in the job's thread, clones the repo, and creates `kiln/<id>-<title>` from the base branch, or from that branch on the remote if an earlier run of the job pushed it. Then it runs the CLI with the brief, the earlier replies in the job's thread, the house rules (`worker/instructions.md`), and the rules for finishing.
4. **Settle.** For a change, the worker commits anything left uncommitted, pushes the branch, and opens a draft PR with the CLI's report as its body. It replies with the report, labels the job `report=pending`, completes, fails, or blocks the task, and exits.
5. **Delete.** The next minute's check deletes the machine. Every machine also has its own deadline, the job timeout plus 30 minutes. If nothing deletes the machine first, boat stops it at the deadline, and with snapshots off a stopped machine keeps nothing.

| The job ends with | The task |
|---|---|
| The report | completed, result `Draft PR: <url>`, `No changes made.`, or the report's first line |
| `QUESTION: ...` | blocked for an answer, with the work pushed. The machine is deleted. An answer puts the job back in the queue, and a new machine resumes from the branch. |
| A non-zero exit, a CLI error, or the timeout (`JOB_TIMEOUT_MINUTES`, default 180) | failed, with the output's tail in the thread |
| A cancel | the worker stops at its next lease renewal; the machine is deleted |

The minute's check also does the following:

| It finds | It does |
|---|---|
| A ready job with no machine | Launches one, within the harness's limit (`machineLimits` in `lib/config.ts`: claude 1, opencode 3). Jobs over the limit wait their turn, oldest first. |
| A machine whose setup failed, or whose job is still unclaimed after 10 minutes | Deletes it and launches another. After 3 launches the job fails, with the reason in its thread. |
| A job for a harness that can't run | Fails it at once, with the reason in its thread: Codex, or a harness without its credential. |

## Set up

Everything lives in the agent's Vercel project; nothing runs on your computer.

1. **A boat API key** with these actions: `sandbox.create`, `sandbox.read`, `sandbox.delete-own`, `environment.read`, `environment.write`, and `exec` (for `workers:logs`). Create it in the boat dashboard. Set it as `BOAT_API_KEY` on the Vercel project, and in `.env` for the status and logs commands.
2. **Worker settings** on the Vercel project. Each `WORKER_<NAME>` is passed to workers as `<NAME>`:

   | Setting | What it is |
   |---|---|
   | `WORKER_BOARD_TOKEN` | A Vercel access token for your account, scoped to the team: <https://vercel.com/account/tokens>. Workers act on the board with it. |
   | `WORKER_VERCEL_ORG_ID` | The team that owns the agent's project: `orgId` in `.vercel/project.json`. |
   | `WORKER_GH_TOKEN` | A GitHub token with Contents and Pull requests read/write on the repos in `lib/config.ts`. |
   | `WORKER_CLAUDE_CODE_OAUTH_TOKEN` | Claude Code's login for claude jobs, from `claude setup-token`. Only claude machines get it. |
   | `WORKER_AI_GATEWAY_API_KEY` | An AI Gateway key for opencode jobs, from the Vercel dashboard (AI Gateway, API keys). Only opencode machines get it. |
   | `WORKER_HARNESS_GH_TOKEN` | Optional. A read-only GitHub token for the coding CLI; see below. |
   | `WORKER_KILN_GIT_NAME`, `WORKER_KILN_GIT_EMAIL` | Optional commit identity. Default: `<agent name> (<harness>)`. |
   | `WORKER_JOB_TIMEOUT_MINUTES` | Optional. Default 180. |

3. **Deploy** with `pnpm run deploy`. It refuses a dirty tree or an unpushed commit, writes the commit's tarball URL to the project as `KILN_WORKER_CODE`, and runs `eve deploy`. Machines run exactly that commit, so a change to `lib/`, `worker/`, or `skills/` reaches workers with the next deploy.

```sh
pnpm workers:status              # every job machine: harness, state, setup, age, job
pnpm workers:logs <job id>       # a running machine's worker log
```

Machines are deleted with their jobs, so the logs of a finished job are gone; its thread on the board (`pnpm exec vb read <job id>`) keeps the report and the output's tail.

## Repo secrets

Each repo's secrets live in its own boat environment, `kiln-<repo>`. kiln creates the environment on first use. The environment passes secrets and nothing else: no GitHub login, no boat key, no agent logins. If someone switches one of those on in the dashboard, kiln switches it off again before the next launch.

- **Setting one.** Ask the agent in Slack ("set the Linear key for player games"), or it asks when a job fails for a missing secret. It posts a button, and the button opens a Slack form. The value goes from the form to boat; the agent never sees it. Only Slack users listed in `KILN_SECRET_ADMINS` can set secrets. Anyone else who clicks is shown their user ID to pass on.
- **Using one.** Jobs get the repo's secrets as environment variables, so MCP servers, tests, and dev servers can read them. A new value reaches the next job; a running one keeps what it started with.
- **Seeing them.** The agent's `list_secrets` shows names only. `boat env info kiln-<repo>` shows everything.
- Names a secret can't take: the worker's own settings (`GH_TOKEN`, `BOARD_TOKEN`, model credentials), anything starting `KILN_` or `GIT_`, `PATH`, `HOME`, `NODE_OPTIONS`, and boat's reserved names.

## Skills, house rules, and MCP

- **Skills** in `skills/workers/` are copied into `~/.claude/skills` (Claude Code and OpenCode) and `~/.codex/skills` (Codex) when a worker starts. A skill for one repo belongs in that repo's own `.claude/skills/`.
- **House rules** in `worker/instructions.md` go into every job's prompt.
- **MCP servers** are defined once in `mcpServers` in `lib/config.ts`. A repo lists the ones its jobs get in its `mcp`. Values may name the repo's secrets as `${NAME}`. A job whose MCP servers need a secret the repo lacks fails and says which.

## Codex

Codex signs in with a ChatGPT login whose refresh token changes each time it is used. A copy handed to a short-lived machine goes stale after the first job, so per-job machines can't run Codex, and Codex jobs fail with that reason. Running it would take a long-lived machine of its own.

## GitHub credentials

The coding CLI runs with permission prompts off, so it gets none of the worker's credentials. Its environment has no `GH_TOKEN` and no `BOARD_TOKEN`, and the settings file is deleted before it starts. Only the worker pushes and opens pull requests. Set `WORKER_HARNESS_GH_TOKEN` to a read-only token (Actions, Contents, Pull requests, Issues: read) if jobs should read CI runs and issues with `gh`. The CLI sees it as its `GH_TOKEN`.

The worker's credentials stay off boat's per-machine environment variables, because boat puts those into every login shell, which is where the CLI runs its commands.

The CLI and the worker run as the same user, so a determined CLI can still read the worker's process environment. The hard boundary is on GitHub: protect each repo's default branch, and scope the GitHub token to the repos in `lib/config.ts`.

Planned, not built: replace the personal token with a GitHub App.

- Installation tokens last an hour and can be minted per job for one repo with only the permissions it needs: a write token for the worker's push and PR, a read token for the CLI.
- PRs come from the App instead of you, so you can approve them. With a personal token you author them and can't.
- Rulesets can target the App, for example to allow it to push only `kiln/*`.
- The App's private key would stay on Vercel, with the agent minting tokens per job, out of the CLI's reach.

## Troubleshooting

Agent logs (`pnpm exec vercel logs`) carry the `machines.*` events. A machine's own log is `pnpm workers:logs <job id>`.

| Log | Means |
|---|---|
| `machines.unconfigured` | The Vercel project lacks a setting; the message names it. Jobs wait as `ready` until it's set. |
| `machines.launch_failed` | boat refused the machine; the error says why. The next minute retries. |
| `machines.reconciled` with `deleted ... setup failed` | The setup script failed; `setupError` says where. Often an undeployed commit: deploy with `pnpm run deploy`. |
| `machines.job_failed` | The job can't run on kiln as configured; the reason is in its thread. |
| `config.invalid` in a machine's log | A worker setting is missing or malformed; the field is named. |
| `job.unavailable` in a machine's log | Another machine had the job, or it was canceled before this one came up. Harmless. |
| A job failed with a usage-limit message | That subscription is spent for now. Retry later, or on another harness. |
