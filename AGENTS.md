# kiln

kiln runs an AI teammate in Slack (the agent) and the coding workers it hands repo work to. The README covers what it does and how to run it; this file is what a coding agent needs before changing it.

## Shape

- `agent/`: an eve agent deployed to Vercel. Slack in, tools, skills, memory, and two per-minute schedules: reports and machines. `channels/slack-interactivity.ts` serves Slack's buttons and forms.
- `worker/`: the process on a job's boat.dev machine. Claims its one job from Vercel Board, runs a coding CLI headless, pushes, opens a draft PR, settles, exits.
- `lib/`: what both sides share. `config.ts` (repos, defaults, MCP servers, machine limits, the agent's name), `jobs.ts` (the job contract), `board-jobs.ts` (Board operations), `boat.ts` (the boat API), `machines.ts` (launching and reconciling job machines), `secrets.ts` (repo secrets in boat environments).
- `scripts/deploy.ts`: deploys the agent and pins the machines' code to the commit. `scripts/boat-workers.ts`: shows machines and their logs.

## Terms

| Term | Means |
|---|---|
| kiln | The platform: everything in this repo. Platform identifiers say kiln. |
| agent | The Slack-facing eve agent kiln runs. Its name is `agent.name` in `lib/config.ts` (robdog, for the owner). Never hardcode the name. |
| job | A Vercel Board task in the `jobs` channel, labeled `kiln=job`. The brief is its text; repo, kind, harness, model, effort, and Slack origin are labels. |
| kind | `change` (branch `kiln/<id>-<title>` and a draft PR) or `investigate` (a report, no changes). |
| harness | The coding CLI a job runs on: `claude`, `codex`, or `opencode`. |
| selection | A job's harness, model, and effort, resolved by `resolveSelection`: request, then repo default for the kind, then global default. Fixed for the job's life. |
| subscription | One Claude login a job runs on (`WORKER_CLAUDE_CODE_OAUTH_TOKEN[_<NAME>]`). A job sticks to one until it runs out, then moves to the next that can run its model, never to another model. |
| ledger | Each subscription's record in Board channel `kiln-accounts`: usage, resets, and benches as labels (`lib/accounts.ts`). |
| machine | A fresh boat machine per job, labeled `kiln=worker` and `job=<id>`. The agent launches it with the job and deletes it after the job settles. |
| worker | The process on a machine: claims its job by ID, runs it, exits. |
| repo secrets | A repo's environment variables, in boat environment `kiln-<repo>`, which passes secrets and nothing else. Set through a Slack form, never through the model. |
| report | A settled job's result. The worker labels it `report=pending`; the agent's schedule delivers it to the Slack origin and clears the label. |
| artifacts | Files a CLI saves in `.kiln/artifacts/`; attached to the report and posted to Slack, never committed. |
| house rules | `worker/instructions.md`, added to every job's prompt. |

## Working here

- Keep the docs current in the same change as the code: `README.md`, `docs/`, this file, and the agent's own `agent/skills/kiln/SKILL.md`, which is how the agent explains kiln to people. A change that makes any of them wrong is not done.
- `pnpm check` must pass: biome, tsc, vitest. Tests need no network or keys; keep it that way.
- Run `pnpm eval` on at least two vendors after changing the agent's instructions or tool descriptions.
- The repo is public. Never commit secrets, account IDs, or private repo details; secrets live in `.env` (ignored) and the Vercel project.
- The coding CLI never gets worker credentials (`GH_TOKEN`, `BOARD_TOKEN`); see `harnessEnv` in `worker/job.ts`. They reach a machine in a settings file the worker deletes, never in boat's per-machine `env`, which boat exports into every login shell.
- Secret values never pass through the model, logs, or the board. Tools return secret names only.
- Deploy with `pnpm run deploy`, never bare `eve deploy`: machines download the deployed commit from GitHub, so it must be committed and pushed.
- Third-party skills are vendored unmodified, with their licenses recorded in `skills/vendor.json`.
- Biome does not format Markdown or skill folders; don't change that.
