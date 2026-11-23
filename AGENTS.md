# kiln

kiln runs an AI teammate in Slack (the agent) and the coding workers it hands repo work to. The README covers what it does and how to run it; this file is what a coding agent needs before changing it.

## Shape

- `agent/`: an eve agent deployed to Vercel. Slack in, tools, skills, two per-minute schedules (reports and machines), and `tasks`, eve's dynamic schedules the agent sets for itself. `channels/slack-interactivity.ts` serves Slack's buttons and forms.
- `worker/`: the process on a job's boat.dev machine. Claims its one job from Vercel Board, runs a coding CLI headless, pushes, opens a draft PR, settles, exits.
- `lib/`: what both sides share. `config.ts` (defaults, machine limits, the agent's name: the same for everyone), `deployment.ts` (the schema for a deployment's repos and MCP servers, which live in the gitignored `kiln.config.yaml`), `jobs.ts` (the job contract), `board-jobs.ts` (Board operations), `boat.ts` (the boat API), `machines.ts` (launching and reconciling job machines), `secrets.ts` (repo secrets in boat environments).
- `scripts/deploy.ts`: deploys the agent and pins the machines' code to the commit. `scripts/boat-workers.ts`: shows machines and their logs.

## Terms

| Term | Means |
|---|---|
| kiln | The platform: everything in this repo. Platform identifiers say kiln. |
| agent | The Slack-facing eve agent kiln runs. Its name is the deployment's (`name` in `kiln.config.yaml`, default `eve`; `agentName()` in `lib/deployment.ts`). Never write a name into code, docs, or tests: each deployment calls its agent something else. |
| project | Repos cloned side by side for every job on it (`projects` in `kiln.config.yaml`; `projectsOf` in `lib/deployment.ts`). A repo in no project is a project of its own. Jobs, defaults, MCP servers, and secrets are keyed by project; the job's `repo` label holds the project's key. |
| job | A Vercel Board task in the `jobs` channel, labeled `kiln=job`; people and the agent call it by its short reference, `#b799fe5c` (`jobRef`). The brief is its text; repo, kind, harness, model, effort, and Slack origin are labels. |
| kind | `change` (branch `<login>/<title>`: the GitHub account behind the worker's `GH_TOKEN`, then a few words of the title, labeled `branch` on the job; and a draft PR) or `investigate` (a report, no changes). |
| harness | The coding CLI a job runs on: `claude`, `codex`, or `opencode`. Workers may use only those in `enabledHarnesses` (`lib/config.ts`): `claude` today, on the inference endpoint. |
| selection | A job's harness, model, and effort, resolved by `resolveSelection`: request, then repo default for the kind, then global default. Fixed for the job's life. |
| inference endpoint | `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` (`lib/inference.ts`): the Anthropic-compatible endpoint the agent's model and every Claude job run on. Both or neither; jobs need it. Without it the agent falls back to AI Gateway, for evals and local development. |
| machine | A boat machine per job, labeled `kiln=worker` and `job=<id>`. The agent launches it with the job and deletes it after the job settles, unless its work is kept. |
| kept work | A job that pauses (an answer, secrets, inference) or fails after 10 minutes of work keeps its clone, uncommitted changes, and Claude Code session on its machine: the worker labels it `resume=<session>`, and the agent stops the machine (its disk saved, nothing billed) and resumes it when the job is ready again; the worker continues the session with `--resume`. A failed job's is kept 3 days (`kept-until`, `keptMachineDays`). Unfinished work never reaches GitHub. Without the machine, the job starts over from its brief and thread. |
| waiting for inference | A Claude job the endpoint rate limits blocks with kind `inference` and `wait-until` (the reset it gave), quietly, with its work kept. While any job waits, no Claude job starts. Once one is due, the agent checks the endpoint with one token and, when it answers, returns them all to the queue, paused work first. It tells each asker once, in a DM edited when it's over (`notice`), straight through Slack since its own turns are down too. A job gives up after a day. |
| worker | The process on a machine: claims its job by ID, runs it, exits. On a resumed machine the agent starts it again. |
| repo secrets | A repo's or project's environment variables, in three groups by reach (`staging`, `production-read`, `production-write`), each its own boat environment `kiln-<key>-<group>`, which passes secrets and nothing else. A job gets one group (its `secrets` label) or none (`kiln-none`). Names are the group's prefix (none, `PROD_READ_`, `PROD_WRITE_`, `GROUP_PREFIX`) and then what the secret is, with no other environment words. Descriptions, owner, and expiry live in `kiln/secrets/secret-labels.json` in Blob. Set through a Slack form and deleted through a confirmed button, never through the model. |
| report | A settled job's result. The worker labels it `report=pending`; the agent's schedule delivers it to the Slack origin and clears the label. It runs as the job's asker (`asker` label: the identity behind the turn that started it, no credentials), because eve refuses a schedule from a turn that runs as the app. A report whose turn failed goes back to pending with backoff (`report-retry`, `report-after`). |
| wish list | Limitations the agent hits in kiln or eve itself, filed with `wish` as tasks in the board's `wishes` channel (`lib/wishes.ts`). Not for a deployment's own business. Complete one when it is built; fail it with the reason when it won't be. |
| drive | The agent's only memory: its files in Vercel Blob (`kiln/drive/`), organized however it likes (`lib/drive.ts`). kiln's own, not eve's memory. |
| `AGENTS.md` (drive) | The agent's whole standing prompt, in its drive, sent as the system prompt every turn: identity, rules, capabilities, people, decisions. Deployment data, edited by the agent and people; previous versions in `.history/`. The code has no other agent prompt: `lib/agents-starter.ts` seeds a new drive once and is the fallback. Not this repo's own `AGENTS.md`, which is for coding agents. |
| job files | Files travel with a job both ways as Board attachments on its task, 10 files of 25 MB each way (`lib/jobs.ts`). In: `start_job`'s `files` (drive or sandbox paths, `lib/job-files.ts`), downloaded to `.kiln/inputs/` before the CLI starts. Out: artifacts. The CLI writes the PR description to `.kiln/pr.md`, for reviewers and free of kiln; kiln adds no footer. Never committed from `.kiln/`. |
| artifacts | Files a CLI saves in `.kiln/artifacts/`, when the brief asks or a person must see one; subfolders included; attached to the report (a subfolder's `/` encoded as `%2F`, since the board keeps only a name's last part: `artifactName`) and saved in the drive under `jobs/<ref>/` at the same path. The update names files left out (over the limits). Never posted automatically: the agent shares one with `drive_share` when someone needs to see it. |
| house rules | `worker/instructions.md`, added to every job's prompt. |

## Working here

- Keep the docs current in the same change as the code: `README.md`, `docs/`, this file, and the agent's own `agent/skills/kiln/SKILL.md`, which is how the agent explains kiln to people. A change that makes any of them wrong is not done.
- `pnpm check` must pass: biome, tsc, vitest. Tests need no network or keys; keep it that way.
- Run `pnpm eval` on at least two vendors after changing the starter prompt (`lib/agents-starter.ts`) or tool descriptions. Evals run on the starter, not on a deployment's drive: `pnpm eval` clears `EVE_MEMORY_BLOB_STORE_ID`, which eve would otherwise load from `.env.local`. Every tool that leaves the process has a stub in `evals/stubs.ts`.
- The repo is public. Never commit secrets, account IDs, or private repo details; secrets live in `.env` (ignored) and the Vercel project.
- The coding CLI never gets worker credentials (`GH_TOKEN`, `BOARD_TOKEN`); see `harnessEnv` in `worker/job.ts`. They reach a machine in a settings file the worker deletes, never in boat's per-machine `env`, which boat exports into every login shell.
- Secret values never pass through the model, logs, or the board. Tools return secret names only. The agent's GitHub token reaches GitHub through its sandbox's firewall, never inside the sandbox (`agent/sandbox/sandbox.ts`).
- kiln ships as a clean slate: the public code names no agent, repos, or servers. A deployment's name, repos, projects, and MCP servers are in `kiln.config.yaml` (gitignored; `kiln.config.example.yaml` shows the shape), which `pnpm run deploy` checks and sends as `KILN_CONFIG`. The agent's repo-aware tools are `defineDynamic` and read it per call; a job's machine gets its own project's repos (`KILN_REPO`), servers (`KILN_MCP_SERVERS`), and the agent's name (`KILN_AGENT_NAME`) only.
- A push to `main` deploys the agent through Vercel's Git integration, and job machines run that same commit (`VERCEL_GIT_COMMIT_SHA`). Run `pnpm run deploy` after changing `kiln.config.yaml`, or to deploy without pushing; never bare `eve deploy`, which skips the config.
- eve gives each Slack thread one Vercel sandbox and applies `agent/sandbox/sandbox.ts`'s environment and network policy only when it creates one; resuming keeps what it was made with. After changing either, delete the project's sandboxes that predate the change (Vercel Sandbox API, `Sandbox.list` and `delete`), or old threads keep running without it. Their scratch files go with them; the drive is in Blob.
- Third-party skills are vendored unmodified, with their licenses recorded in `skills/vendor.json`.
- Biome does not format Markdown or skill folders; don't change that.
