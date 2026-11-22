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
| kind | `change` (branch `kiln/<id>-<title>` and a draft PR) or `investigate` (a report, no changes). |
| harness | The coding CLI a job runs on: `claude`, `codex`, or `opencode`. Workers may use only those in `enabledHarnesses` (`lib/config.ts`): `claude` today, on the inference endpoint. |
| selection | A job's harness, model, and effort, resolved by `resolveSelection`: request, then repo default for the kind, then global default. Fixed for the job's life. |
| inference endpoint | `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` (`lib/inference.ts`): the Anthropic-compatible endpoint the agent's model and every Claude job run on. Both or neither; jobs need it. Without it the agent falls back to AI Gateway, for evals and local development. |
| machine | A fresh boat machine per job, labeled `kiln=worker` and `job=<id>`. The agent launches it with the job and deletes it after the job settles. |
| worker | The process on a machine: claims its job by ID, runs it, exits. |
| repo secrets | A repo's or project's environment variables, in boat environment `kiln-<key>`, which passes secrets and nothing else. Set through a Slack form, never through the model. |
| report | A settled job's result. The worker labels it `report=pending`; the agent's schedule delivers it to the Slack origin and clears the label. It runs as the job's asker (`asker` label: the identity behind the turn that started it, no credentials), because eve refuses a schedule from a turn that runs as the app. |
| wish list | Limitations the agent hits in kiln or eve itself, filed with `wish` as tasks in the board's `wishes` channel (`lib/wishes.ts`). Not for a deployment's own business. Complete one when it is built; fail it with the reason when it won't be. |
| drive | The agent's only memory: its files in Vercel Blob (`kiln/drive/`), organized however it likes (`lib/drive.ts`). kiln's own, not eve's memory. |
| `AGENTS.md` (drive) | The agent's whole standing prompt, in its drive, sent as the system prompt every turn: identity, rules, capabilities, people, decisions. Deployment data, edited by the agent and people; previous versions in `.history/`. The code has no other agent prompt: `lib/agents-starter.ts` seeds a new drive once and is the fallback. Not this repo's own `AGENTS.md`, which is for coding agents. |
| job files | Files travel with a job both ways as Board attachments on its task, 10 files of 25 MB each way (`lib/jobs.ts`). In: `start_job`'s `files` (drive or sandbox paths, `lib/job-files.ts`), downloaded to `.kiln/inputs/` before the CLI starts. Out: artifacts. The CLI writes the PR description to `.kiln/pr.md`, for reviewers and free of kiln; kiln adds no footer. Never committed from `.kiln/`. |
| artifacts | Files a CLI saves in `.kiln/artifacts/`, when the brief asks or a person must see one; attached to the report and saved in the drive under `jobs/<ref>/`. Never posted automatically: the agent shares one with `drive_share` when someone needs to see it. |
| house rules | `worker/instructions.md`, added to every job's prompt. |

## Working here

- Keep the docs current in the same change as the code: `README.md`, `docs/`, this file, and the agent's own `agent/skills/kiln/SKILL.md`, which is how the agent explains kiln to people. A change that makes any of them wrong is not done.
- `pnpm check` must pass: biome, tsc, vitest. Tests need no network or keys; keep it that way.
- Run `pnpm eval` on at least two vendors after changing the starter prompt (`lib/agents-starter.ts`) or tool descriptions. Evals run on the starter, not on a deployment's drive.
- The repo is public. Never commit secrets, account IDs, or private repo details; secrets live in `.env` (ignored) and the Vercel project.
- The coding CLI never gets worker credentials (`GH_TOKEN`, `BOARD_TOKEN`); see `harnessEnv` in `worker/job.ts`. They reach a machine in a settings file the worker deletes, never in boat's per-machine `env`, which boat exports into every login shell.
- Secret values never pass through the model, logs, or the board. Tools return secret names only. The agent's GitHub token reaches GitHub through its sandbox's firewall, never inside the sandbox (`agent/sandbox/sandbox.ts`).
- kiln ships as a clean slate: the public code names no agent, repos, or servers. A deployment's name, repos, projects, and MCP servers are in `kiln.config.yaml` (gitignored; `kiln.config.example.yaml` shows the shape), which `pnpm run deploy` checks and sends as `KILN_CONFIG`. The agent's repo-aware tools are `defineDynamic` and read it per call; a job's machine gets its own project's repos (`KILN_REPO`), servers (`KILN_MCP_SERVERS`), and the agent's name (`KILN_AGENT_NAME`) only.
- A push to `main` deploys the agent through Vercel's Git integration, and job machines run that same commit (`VERCEL_GIT_COMMIT_SHA`). Run `pnpm run deploy` after changing `kiln.config.yaml`, or to deploy without pushing; never bare `eve deploy`, which skips the config.
- Third-party skills are vendored unmodified, with their licenses recorded in `skills/vendor.json`.
- Biome does not format Markdown or skill folders; don't change that.
