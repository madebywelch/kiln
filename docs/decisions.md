# Decisions

Choices that shaped kiln and why. The code shows what kiln does; this records the choices it rests on, so a change doesn't undo one by accident. Facts about the services kiln runs on are in [field-notes.md](field-notes.md); unsettled questions in [open-questions.md](open-questions.md).

## One agent, one mind

- The agent has context from everywhere it is present: channels, DMs, every person. Knowing in a DM what was asked in a channel is the point, not a leak. Isolated context is a deliberate opt-in, never the default.
- No identity config to get started. Nothing maps Slack users in `.env`.
- It hears a channel without being addressed: it reads the channel's recent history and judges whether to speak (`agent/lib/ambient.ts`), instead of waiting for an @mention.
- When convenience and isolation trade off, kiln leans to convenience and says where the trust boundary is (README, Trust).

## Capabilities, not workflows

- kiln gives the agent capabilities: tools, CLIs, credentials. How it uses them (when to merge, what to check after a job) is workflow, and lives in its drive's `AGENTS.md`, agreed between the agent and its people. Workflows are not frozen in code: no state machines, watchers, or guards unless asked for.
- No per-person permissions or allowlists. The workspace is trusted as a whole.

## Models

- Model access is vendor-agnostic. No vendor SDKs or vendor-only request fields in kiln's core.
- The agent runs on the deployment's inference endpoint (`INFERENCE_BASE_URL`, `INFERENCE_API_KEY`). Evals run there too, never on AI Gateway: `pnpm eval` blocks Gateway outright.
- The agent's model and reasoning are the operator's choice. Don't change `KILN_MODEL` or `KILN_REASONING`, or add production overrides for them, to save cost; raise the cost instead.
- Workers run Claude Code on the inference endpoint, never AI Gateway.
- A job's harness and model never change during its life. When the endpoint runs out, the job waits (`waiting for inference`); kiln never downgrades it to a cheaper model.

## Workers

- One fresh boat.dev machine per job, deleted when the job settles. Nothing runs on a laptop; no Docker path for workers. Idle means no machines.
- Worker credentials never reach the coding CLI (AGENTS.md). For the same reason kiln doesn't use boat's "GitHub repositories" environment feature: it puts the GitHub token on the machine, where the permission-free CLI could use it.
- Unfinished work never reaches GitHub. Paused or failed work is kept on the stopped machine instead (`kept work`).
- A job reuses its branch's pull request only when that pull request is open. A closed or merged one on a branch of the same name is earlier work whose deleted branch the job's title happened to match.

## Secrets

- Three groups by reach (staging, production-read, production-write), and a name's prefix is its group, so a name and its group can't disagree.
- A secret's reach is never inferred from its name, and values are never moved between groups by script. Only the person who made a credential knows how far it reaches; old names have been wrong before. People re-enter values through the Slack form, and the agent asks when a group is unclear.

## Shipping

- A push to `main` is the deploy. Finished work is committed and pushed once `pnpm check` passes; uncommitted work looks done but never reaches Slack.
- kiln is a clean slate for anyone. The public repo names no deployment's agent, repos, servers, or accounts. Tests, evals, and docs use `acme/web`.

## History

kiln has been rebuilt three times. Earlier forms are only in git history, and are the reference when a feature returns:

1. A software factory: workflow engine, Pi harness, boat.dev and agent37 sandboxes. Last at `515dd4a`.
2. A Go always-on agent: one process, SQLite, five primitives (inbox, timers, memory folder, permission gate, outbox), a Socket Mode Slack adapter. Last at `410927f`.
3. The current form: an eve agent on Vercel, Vercel Board as the job bus, coding CLIs on boat.dev machines.

What carried through every form: keep it as simple as possible, with strong primitives; an extensible channel system; durable work that survives interruptions; one shared context.
