# Workers

Every job runs on its own boat.dev machine. The agent launches the machine when it starts the job and deletes it once the job settles, unless the job's work is kept: then it stops the machine and resumes it when the job is ready again (see "Kept work"). A stopped machine costs nothing. With no jobs running, nothing is billed.

Workers run Claude Code on the deployment's inference endpoint (`INFERENCE_BASE_URL` and `INFERENCE_API_KEY`). `enabledHarnesses` in `lib/config.ts` lists the coding CLIs they may use; out of the box that is Claude Code. OpenCode, for AI Gateway models, is built in and switched off, and Codex waits on lending its login to per-job machines. A job for a harness that is off fails at once with that reason.

## A machine's life

1. **Launch.** `start_job` posts the job and asks boat for a machine right away. A schedule on the agent checks every minute as well, so a launch that failed is retried. The machine starts in the repo's own boat environment, so it gets that repo's secrets and no other's.
2. **Setup**, about 20 seconds. The setup script downloads kiln at the commit the agent was deployed from, installs the worker's dependencies, and starts the worker. The worker reads its settings file (`~/.kiln/worker.json`, mode 600) into its environment and deletes it.
3. **The job.** The worker claims its job by ID, with a 5-minute lease it renews every 100 seconds. It replies "Started by claude: claude opus/high on owner/repo." in the job's thread. On a resumed machine it continues the kept work (see "Kept work"); otherwise it clones the repo and creates the job's branch from the base branch, or from that branch on the remote if an earlier run of the job pushed it. The branch is `<login>/<title>`: the GitHub account behind `GH_TOKEN`, then the title's first words, up to 40 characters. When that name is already a branch on the remote, the job's reference is added (`octocat/add-snow-b799fe5c`), since the worker force-pushes its branch. The first run labels the job `branch=<name>`, and every later run uses it. For a project, it clones each of the project's repos into a subfolder named by its key, creates the branch in each, and runs the CLI from the folder above them; afterwards it pushes each repo the CLI committed to and opens a draft PR for each. It downloads the files the agent attached to the job's task into `.kiln/inputs/` (excluded from git, as all of `.kiln/` is), so a file goes into the repo only where the CLI copies it. Then it runs the CLI with the brief, the earlier replies in the job's thread, the house rules (`worker/instructions.md`), and the rules for finishing.
4. **Settle.** For a change, the worker commits anything left uncommitted, pushes the branch, and opens a draft PR. Its description is the one the CLI wrote for the repo's reviewers in `.kiln/pr.md` (or `.kiln/pr-<repo>.md` in a project), never committed; without one, the CLI's report. The CLI is told to keep it under 250 words and follow the repo's pull request template if it has one: what changed and why, what a reviewer needs that the diff doesn't show, and how it was verified. Dropped approaches, costs, and environment trouble go in the report instead. kiln adds nothing to it; the job's result links the PR. It replies with the report and attaches the files the CLI left in `.kiln/artifacts/`, subfolders included and kept as paths (10 files, 25 MB each; the update names any left out), plus the whole report as `full-report.md` when it is longer than the 6,000 characters a job update carries, which the agent posts in the thread and saves in its drive under `jobs/<id>/`. It labels the job `report=pending`, completes, fails, or blocks the task, and exits.
5. **Delete or stop.** The next minute's check deletes the machine, or stops it when the job's work is kept. Every machine also has its own deadline, the job timeout plus 30 minutes after it starts or resumes. If nothing acts first, boat stops it at the deadline, keeping its disk; the check then deletes it once its job is over.

| The job ends with | The task |
|---|---|
| The report | completed, result `Draft PR: <url>`, `No changes made.`, or the report's first line |
| `QUESTION: ...` | blocked for an answer, with the work kept on the machine, which is stopped. An answer puts the job back in the queue, and the machine resumes with the same session. |
| A rate limit from the inference endpoint | blocked with kind `inference`, with the work kept. No report: see "Waiting for inference". |
| A non-zero exit, a CLI error, or the timeout (`JOB_TIMEOUT_MINUTES`, default 180) | failed, with the output's tail in the thread. After 10 minutes of work, or on a run that continued kept work, the work is kept for 3 days. |
| A cancel | the worker stops at its next lease renewal; the machine is deleted |

The minute's check also does the following:

| It finds | It does |
|---|---|
| A ready job with no machine | Launches one, up to `machineLimits` per harness (4 for Claude, 3 for OpenCode if enabled). Jobs over a limit wait their turn: kept work first, then priority jobs (`priority=high`, from `start_job`'s `priority` or `prioritize_job`), then oldest first. |
| A ready job whose machine is stopped | Moves the machine to the latest version of its repo's secrets, resumes it, and, once it is up, writes the worker's settings file and starts the worker, once per resume. A machine whose saved disk is gone is deleted, and the job starts over. |
| A paused or failed job whose machine is running | Stops it, when the job's work is kept; otherwise deletes it. A failed job's stopped machine is deleted after 3 days. |
| A job waiting for inference | See "Waiting for inference". |
| A machine whose setup failed, or whose job is still unclaimed after 10 minutes | Deletes it and launches another. After 3 launches the job fails, with the reason in its thread. |
| A job for a harness that can't run | Fails it at once, with the reason in its thread: Codex, or a harness without its credential. |

## Kept work

Unfinished work never reaches GitHub, and paused or failed work is not thrown away. A run's machine is worth keeping when the job pauses after the CLI ran (a question, a secret, a rate limit), or fails after 10 minutes of work (`KEEP_AFTER_MS`) or on a run that itself continued kept work. The worker then leaves the clone in place and labels the job `resume=<session>`: the Claude Code session to continue, or `disk` for a CLI without one. The agent stops the machine. boat saves its disk, uncommitted changes and Claude Code's session history included, keeps it at least 14 days, and bills nothing while it is stopped.

When the job is ready again (answered, its secrets set, inference back, or `retry_job`), the agent resumes the machine and starts the worker. The worker skips the clone and runs `claude --resume <session>` with what happened since it stopped: its own question and the answer, or the failure. The model picks up with its whole history, not a summary.

- A failed job's machine is kept for 3 days (`kept-until`; `keptMachineDays` in `lib/config.ts`), then deleted. `retry_job` with `fresh` deletes it at once, so the retry starts over.
- When the machine is gone (deleted, expired, or a resume that fails), the job starts over on a fresh clone with its brief and the replies in its thread, as before.
- The worker's settings file is written again at each resume, through boat's file API, never in a command, which boat keeps in the machine's history. The worker deletes it once read, and again once it holds the job.

## Waiting for inference

When the inference endpoint refuses a Claude job for a rate limit, the job doesn't fail. The worker blocks it with kind `inference`, keeps its work, and labels it with when to check again (`wait-until`: the reset the endpoint gave, or 15 minutes), when it started waiting (`wait-since`), and the model it was refused (`wait-model`). There is no report.

While any job waits, the minute's check starts no Claude job, new or resumed. Once a job is due, it asks the endpoint for one token on that model. A rate limit, a 5xx, or no answer sets the next check; any other answer means the endpoint is back, and every waiting job returns to the queue, paused work first. A job that has waited a day fails, with its work kept.

The agent's own turns run on the same endpoint, so it can't speak in Slack while the endpoint is down. The check tells each asker once, in a DM posted straight through Slack's API: jobs are paused until about the reset time. It edits that message when inference is back, or when jobs gave up waiting. Job threads stay quiet.

## Set up

Everything lives in the agent's Vercel project; nothing runs on your computer.

1. **A boat API key** with these actions: `sandbox.create`, `sandbox.read`, `sandbox.stop`, `sandbox.resume`, `sandbox.delete-own`, `environment.read`, `environment.write`, `exec`, and `file.write`. Stop, resume, exec, and file writes keep and continue a job's work; exec also serves `workers:logs`. Create it in the boat dashboard. Set it as `BOAT_API_KEY` on the Vercel project, and in `.env` for the status and logs commands.

   Turn snapshots on and zero data retention off for the account (boat dashboard, Account tab). With zero data retention on, a stop erases the machine's data instead of keeping a snapshot, so the job starts over. Without snapshots a stop erases a machine, so kiln launches machines without snapshots, logs `machines.snapshots_off`, and deletes a paused or failed job's machine instead of keeping its work: the job then starts over from its brief and thread.
2. **Worker settings** on the Vercel project. Each `WORKER_<NAME>` is passed to workers as `<NAME>`:

   | Setting | What it is |
   |---|---|
   | `WORKER_BOARD_TOKEN` | A Vercel access token for your account, scoped to the team: <https://vercel.com/account/tokens>. Workers act on the board with it. |
   | `WORKER_VERCEL_ORG_ID` | The team that owns the agent's project: `orgId` in `.vercel/project.json`. |
   | `WORKER_GH_TOKEN` | A GitHub token with Contents and Pull requests read/write on the repos in `kiln.config.yaml`. |
   | `INFERENCE_BASE_URL`, `INFERENCE_API_KEY` | Not `WORKER_`-prefixed: the agent's model uses them too. The Anthropic-compatible endpoint Claude jobs run on; only Claude machines get them. See Inference below. |
   | `WORKER_AI_GATEWAY_API_KEY` | Only if you enable OpenCode (`enabledHarnesses`): an AI Gateway key for its per-token models. Only OpenCode machines get it. |
   | `WORKER_HARNESS_GH_TOKEN` | Optional. A read-only GitHub token for the coding CLI; see below. |
   | `WORKER_KILN_GIT_NAME`, `WORKER_KILN_GIT_EMAIL` | Optional commit identity. Default: the owner of `WORKER_GH_TOKEN`, as their login and GitHub noreply address, since that token pushes the commits. Claude Code adds no co-author trailer or "Generated with" line (`CLAUDE_SETTINGS` in `worker/harness.ts`). |
   | `WORKER_JOB_TIMEOUT_MINUTES` | Optional. Default 180. |

3. **Deploy** with `pnpm run deploy`. It refuses a dirty tree or an unpushed commit, writes the commit's tarball URL to the project as `KILN_WORKER_CODE`, sends `kiln.config.yaml`, and runs `eve deploy`. Machines run the commit the agent was built from: Vercel's `VERCEL_GIT_COMMIT_SHA` when the project is connected to its GitHub repo, so a push to `main` that Vercel deploys on its own keeps agent and workers on the same commit, else `KILN_WORKER_CODE`. Changes to `kiln.config.yaml` still need `pnpm run deploy`.

```sh
pnpm workers:status              # every job machine: harness, state, setup, age, job
pnpm workers:logs <job id>       # a running machine's worker log
```

Machines are deleted with their jobs, so the logs of a finished job are gone; its thread on the board (`pnpm exec vb read <job id>`) keeps the report and the output's tail.

## Inference

Claude jobs run Claude Code against the deployment's inference endpoint, `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` on the agent's Vercel project. The agent puts both in a Claude machine's settings file; the worker hands them to Claude Code as `ANTHROPIC_BASE_URL` (the host without `/v1`) and `ANTHROPIC_API_KEY`, and the machine's log records the endpoint's host at `job.harness`. `machineLimits.claude` caps how many run at once. Without both settings, Claude jobs fail at once with the reason, and a worker refuses to start (`config.invalid`). A job's model never changes after it starts.

## Repo secrets

A repo's or project's secrets live in three groups, by how far they reach, each its own boat environment, `kiln-<key>-<group>` (`lib/secrets.ts`):

| Group | Holds |
|---|---|
| `staging` | staging and development: test databases, sandbox and staging API keys, keys that only spend money |
| `production-read` | production, read only: read-only database logins, read-only API keys, billing and analytics reads |
| `production-write` | production, able to change it: write database logins, deploy tokens, cluster credentials, admin API keys |

A job names one group in its `secrets` label, or none, the default, and its machine starts in that group's environment, or in `kiln-none`, which holds nothing. kiln creates each environment on first use. They pass secrets and nothing else: no GitHub login, no boat key, no agent logins. If someone switches one of those on in the dashboard, kiln switches it off again before the next launch.

Each group has a fixed name prefix (`GROUP_PREFIX`): staging names are plain (`DATABASE_URL`), production-read names start `PROD_READ_` (`PROD_READ_DATABASE_URL`), production-write names start `PROD_WRITE_`. The rest of the name says what the secret is, with no other environment word (`DEV`, `STAGING`, `PROD`, `READONLY`, and the like), and kiln refuses a name that doesn't fit its group. A name and its group can't disagree, and the same name means the same thing in every project. The prefix also keeps production away from a repo's own code, which reads plain names: a job with production secrets is told to pass one, under the name the code reads, to the one command that needs it.

What a secret is, who saved it, when, and its expiry are kept beside it in the agent's Blob store (`kiln/secrets/secret-labels.json`, `lib/secret-labels.ts`), because boat keeps names and values only. A label holds no value.

- **Setting one.** Ask the agent in Slack ("set the Linear key for the website"), or it asks when a job is paused for one. It names the group, a description, and an expiry if there is one, and posts a button that opens a Slack form. The value goes from the form to boat; the agent never sees it. Anyone in the workspace can set them until `KILN_SECRET_ADMINS` lists Slack user IDs; then only those can, and anyone else who clicks is shown their ID to pass on.
- **Using one.** A job gets its group's secrets as environment variables, so tests and dev servers can read them, and its prompt lists their names and descriptions. It gets only the MCP servers whose every `${NAME}` its group holds. A new value reaches the next job; a running one keeps what it started with.
- **Deleting one.** The agent's `delete_secret` posts a Delete button that Slack asks the person to confirm; the delete and its label go together.
- **Hidden in output.** The agent gives the worker the names and descriptions of the job's secrets (`KILN_SECRETS`, never values), and the worker replaces each value with `[NAME hidden]` in everything that leaves the machine or outlives the run: the job update and settle message, returned files that are text, the pull request description, its own log, the job's logs, and the CLI's own logs and sessions on the machine (`worker/mask.ts`). It hides the value as is, URL-encoded, and base64-encoded, a URL's password on its own, and long tokens inside a structured or base64 value (a kubeconfig's token). Values under 8 characters are left alone. When it hid something, the update starts with **Secrets hidden** and the names. It refuses to push commits that hold a secret's value and fails the job, naming the secret.
- **Seeing them.** The agent's `list_secrets` shows each group's names, descriptions, who saved them, and expiry; never values. `boat env info kiln-<key>-<group>` shows everything.

### Paused for secrets

A job pauses, instead of failing, when its group lacks a secret it needs:

- **Before it runs:** an MCP server it was given names a secret its environment lacks. The agent gives a job only servers its group holds every secret for, so this means the secret was deleted after launch.
- **Mid-run:** the CLI ends with `SECRET: NAME, OTHER_NAME: what for`. Every job's prompt tells it to name the variable and never ask for the value. The work so far stays on the machine.

The worker blocks the job with kind `needs_secret` and labels it `needs_secrets=NAME,OTHER_NAME`. The agent posts a "Set NAME" button for each name, in the job's group, tied to the job. A job with no secrets can't gain a group on its machine, so it is started again with one instead. Saving the last missing one unblocks the job, and within a minute its machine resumes, upgraded to the environment's latest version so the secret is in its environment, and continues the session. A job that paused before anything ran gets a fresh machine. Until then the thread says which names are still missing.
- Names a secret can't take: the worker's own settings (`GH_TOKEN`, `BOARD_TOKEN`, model credentials), anything starting `KILN_` or `GIT_`, `PATH`, `HOME`, `NODE_OPTIONS`, and boat's reserved names.

## Skills, house rules, and MCP

- **Skills** in `skills/workers/` are copied into `~/.claude/skills` (Claude Code and OpenCode) and `~/.codex/skills` (Codex) when a worker starts. A skill for one repo belongs in that repo's own `.claude/skills/`.
- **House rules** in `worker/instructions.md` go into every job's prompt.
- **MCP servers** are this deployment's own settings, kept out of the public code in `kiln.config.yaml`, which git ignores. Copy `kiln.config.example.yaml` to start. Define each server once under `mcpServers`, as a hosted `url` with `headers`, or a `command` the machine runs with `args` and `env`. List the servers each repo's jobs get under `repos`. Values may name the repo's secrets as `${NAME}`, including a private server's URL. `pnpm run deploy` checks the file, refusing unknown repos, undefined servers, and broken YAML, and sends it, with the repos, to the Vercel project as `KILN_CONFIG`. The agent puts only the job's own repo and its servers in the machine's settings. Servers have to accept a token: jobs have no browser for an OAuth sign-in. A job whose MCP servers need a secret the repo lacks pauses before anything runs; see "Paused for secrets" above.

## Codex

Codex signs in with a ChatGPT login whose refresh token changes each time it is used. A copy handed to a short-lived machine goes stale after the first job, so per-job machines can't run Codex, and Codex jobs fail with that reason. Running it would take a long-lived machine of its own.

## GitHub credentials

The agent has GitHub too: `gh` and `git` in its sandbox, for checking PRs and CI and for merging when you ask. Its token is `KILN_GH_TOKEN` on the Vercel project, or `WORKER_GH_TOKEN` when that is unset. The token never enters the sandbox: on Vercel, the sandbox firewall adds it to requests to `api.github.com` and `github.com` (`agent/sandbox/sandbox.ts`), and the sandbox's own `GH_TOKEN` is a placeholder. Merging needs Contents and Pull requests write; reading CI needs Actions and Checks read. A session's sandbox keeps the token it was created with, so a new token reaches new threads.

The coding CLI runs with permission prompts off, so it gets none of the worker's credentials. Its environment has no `GH_TOKEN` and no `BOARD_TOKEN`, and the settings file is deleted before it starts. Only the worker pushes and opens pull requests. Set `WORKER_HARNESS_GH_TOKEN` to a read-only token (Actions, Contents, Pull requests, Issues: read) if jobs should read CI runs and issues with `gh`. The CLI sees it as its `GH_TOKEN`.

The worker's credentials stay off boat's per-machine environment variables, because boat puts those into every login shell, which is where the CLI runs its commands.

The CLI and the worker run as the same user, so a determined CLI can still read the worker's process environment. The hard boundary is on GitHub: protect each repo's default branch, and scope the GitHub token to the repos in `kiln.config.yaml`.

Planned, not built: replace the personal token with a GitHub App.

- Installation tokens last an hour and can be minted per job for one repo with only the permissions it needs: a write token for the worker's push and PR, a read token for the CLI.
- PRs come from the App instead of you, so you can approve them. With a personal token you author them and can't.
- Rulesets can target the App, for example to allow it to push only its job branches.
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
