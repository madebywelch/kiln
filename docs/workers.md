# Workers

Every job runs on its own fresh boat.dev machine. The agent launches the machine when it starts the job and deletes it once the job settles. With no jobs, there are no machines and nothing to pay for.

Workers run on subscriptions only. `enabledHarnesses` in `lib/config.ts` lists the coding CLIs they may use; out of the box that is Claude Code. OpenCode, for AI Gateway models billed per token, is built in and switched off, and Codex waits on lending its login to per-job machines. A job for a harness that is off fails at once with that reason.

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
| A ready job with no machine | Launches one. A Claude job goes on the first subscription with room (`jobsPerSubscription`, 2) that can run its model. If OpenCode is enabled, its jobs are capped at `machineLimits` (3). Jobs over a limit wait their turn, oldest first. |
| A ready Claude job whose every subscription is out of usage for its model | Labels it `waiting` with the earliest reset, tells its thread once, and launches it when that subscription resets. |
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
   | `WORKER_GH_TOKEN` | A GitHub token with Contents and Pull requests read/write on the repos in `kiln.config.yaml`. |
   | `WORKER_CLAUDE_CODE_OAUTH_TOKEN`, `WORKER_CLAUDE_CODE_OAUTH_TOKEN_<NAME>` | One per Claude subscription, from `claude setup-token` signed in to it. The bare one is subscription `main`; the others are named by their suffix (`_2` is `2`, `_VERIFIED` is `verified`). Only Claude machines get them; see Subscriptions below. |
   | `WORKER_AI_GATEWAY_API_KEY` | Only if you enable OpenCode (`enabledHarnesses`): an AI Gateway key for its per-token models. Only OpenCode machines get it. |
   | `WORKER_HARNESS_GH_TOKEN` | Optional. A read-only GitHub token for the coding CLI; see below. |
   | `WORKER_KILN_GIT_NAME`, `WORKER_KILN_GIT_EMAIL` | Optional commit identity. Default: `<agent name> (<harness>)`. |
   | `WORKER_JOB_TIMEOUT_MINUTES` | Optional. Default 180. |

3. **Deploy** with `pnpm run deploy`. It refuses a dirty tree or an unpushed commit, writes the commit's tarball URL to the project as `KILN_WORKER_CODE`, and runs `eve deploy`. Machines run exactly that commit, so a change to `lib/`, `worker/`, or `skills/` reaches workers with the next deploy.

```sh
pnpm workers:status              # every job machine: harness, state, setup, age, job
pnpm workers:logs <job id>       # a running machine's worker log
```

Machines are deleted with their jobs, so the logs of a finished job are gone; its thread on the board (`pnpm exec vb read <job id>`) keeps the report and the output's tail.

## Subscriptions

kiln routes Claude jobs across every subscription it has a token for, and never changes a job's model.

- **Sticky.** A job runs on one subscription until that subscription runs out, so its prompt cache stays warm. Subscriptions fill in order: `main`, then by name. A later subscription's 5-hour window starts only when the ones before it are busy or out.
- **Learning limits.** Claude Code reports usage on every run (`rate_limit_event`): each window's use, its reset, and whether it is exhausted. The worker writes this to the subscription's record on the board, a message in channel `kiln-accounts` labeled `usage.<window>`, `reset.<window>`, and `bench.<scope>`. Tokens never go there. A 5-hour or weekly window that runs out benches the subscription for every model. A model's own weekly window, such as Fable's on verified accounts, benches it for that model only.
- **Mid-job.** When a run's subscription runs out, the worker stops it, benches the subscription, and runs `claude -p --resume <session>` on the next subscription that can run the job's model, on the same machine. The thread gets a line saying so. The first turn after a switch rebuilds the prompt cache, and Claude drops reasoning made under the other account. The job's work and conversation carry over.
- **All out.** With no subscription left for the model, the worker pushes the work, labels the job `waiting` with the earliest reset, and hands it back. The agent tells the thread once. The job relaunches at the reset on the same model, unless someone cancels it and starts it again on another.
- The worker gets every token that can run the job, because it switches without the agent. The coding CLI gets only the one in use, as `CLAUDE_CODE_OAUTH_TOKEN`.

## Repo secrets

Each repo's secrets live in its own boat environment, `kiln-<repo>`. kiln creates the environment on first use. The environment passes secrets and nothing else: no GitHub login, no boat key, no agent logins. If someone switches one of those on in the dashboard, kiln switches it off again before the next launch.

- **Setting one.** Ask the agent in Slack ("set the Linear key for the website"), or it asks when a job is paused for one. It posts a button, and the button opens a Slack form. The value goes from the form to boat; the agent never sees it. Anyone in the workspace can set them until `KILN_SECRET_ADMINS` lists Slack user IDs; then only those can, and anyone else who clicks is shown their ID to pass on.
- **Using one.** Jobs get the repo's secrets as environment variables, so MCP servers, tests, and dev servers can read them. A new value reaches the next job; a running one keeps what it started with.
- **Seeing them.** The agent's `list_secrets` shows names only. `boat env info kiln-<repo>` shows everything.

### Paused for secrets

A job pauses, instead of failing, when its repo lacks a secret it needs:

- **Before it runs:** its MCP servers name a secret (`${NAME}`) the repo doesn't have. The worker checks before the CLI starts.
- **Mid-run:** the CLI ends with `SECRET: NAME, OTHER_NAME: what for`. Every job's prompt tells it to name the variable and never ask for the value. The worker pushes the work so far.

The worker blocks the job with kind `needs_secret` and labels it `needs_secrets=NAME,OTHER_NAME`. The agent posts a "Set NAME" button for each name, tied to the job. Saving the last missing one unblocks the job, and a fresh machine resumes it within a minute, from its pushed branch, with the secret in its environment. Until then the thread says which names are still missing.
- Names a secret can't take: the worker's own settings (`GH_TOKEN`, `BOARD_TOKEN`, model credentials), anything starting `KILN_` or `GIT_`, `PATH`, `HOME`, `NODE_OPTIONS`, and boat's reserved names.

## Skills, house rules, and MCP

- **Skills** in `skills/workers/` are copied into `~/.claude/skills` (Claude Code and OpenCode) and `~/.codex/skills` (Codex) when a worker starts. A skill for one repo belongs in that repo's own `.claude/skills/`.
- **House rules** in `worker/instructions.md` go into every job's prompt.
- **MCP servers** are this deployment's own settings, kept out of the public code in `kiln.config.yaml`, which git ignores. Copy `kiln.config.example.yaml` to start. Define each server once under `mcpServers`, as a hosted `url` with `headers`, or a `command` the machine runs with `args` and `env`. List the servers each repo's jobs get under `repos`. Values may name the repo's secrets as `${NAME}`, including a private server's URL. `pnpm run deploy` checks the file, refusing unknown repos, undefined servers, and broken YAML, and sends it, with the repos, to the Vercel project as `KILN_CONFIG`. The agent puts only the job's own repo and its servers in the machine's settings. Servers have to accept a token: jobs have no browser for an OAuth sign-in. A job whose MCP servers need a secret the repo lacks pauses before anything runs; see "Paused for secrets" above.

## Codex

Codex signs in with a ChatGPT login whose refresh token changes each time it is used. A copy handed to a short-lived machine goes stale after the first job, so per-job machines can't run Codex, and Codex jobs fail with that reason. Running it would take a long-lived machine of its own.

## GitHub credentials

The coding CLI runs with permission prompts off, so it gets none of the worker's credentials. Its environment has no `GH_TOKEN` and no `BOARD_TOKEN`, and the settings file is deleted before it starts. Only the worker pushes and opens pull requests. Set `WORKER_HARNESS_GH_TOKEN` to a read-only token (Actions, Contents, Pull requests, Issues: read) if jobs should read CI runs and issues with `gh`. The CLI sees it as its `GH_TOKEN`.

The worker's credentials stay off boat's per-machine environment variables, because boat puts those into every login shell, which is where the CLI runs its commands.

The CLI and the worker run as the same user, so a determined CLI can still read the worker's process environment. The hard boundary is on GitHub: protect each repo's default branch, and scope the GitHub token to the repos in `kiln.config.yaml`.

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
| A job failed with `invalid_json_schema` | The model's provider refused one of the repo's MCP tool schemas. OpenAI models reject regex lookaround, which zod's `.email()` produces. Run that repo's jobs on claude (`defaults` in `kiln.config.yaml`), or loosen the schema in the MCP server. |
| `config.invalid` in a machine's log | A worker setting is missing or malformed; the field is named. |
| `job.unavailable` in a machine's log | Another machine had the job, or it was canceled before this one came up. Harmless. |
| `job.subscription_switched` in a machine's log | Its subscription ran out; the job resumed on the next one. |
| `job.waiting`, or a job labeled `waiting` | Every subscription that can run its model is out; it starts again at the reset. `list_subscriptions` in Slack shows usage. |
