# Open questions

Unsettled problems and choices, with what is known so far. Move an item into the code and [decisions.md](decisions.md) once it's settled, and delete it here.

## Why a job report gets a new sandbox

The agent's Vercel Sandbox cost grows with its turns, not its work.
- **Usage:** sandboxes used about 1% of the CPU paid for.
- **No reuse:** in one three-hour window, 50 sandboxes were created, each for a different eve session, while that window's job reports went to about ten Slack threads. eve is meant to give a thread one session (AGENTS.md assumes so), and a report sends into the job's origin thread.
- **Ruled out:** the per-minute schedules (code only, no model turns) and ambient channel messages (too few).
- **Not yet checked:** the session's workflow run.
- **Why it matters beyond cost:** if each report starts a fresh session, the agent answers it without the thread's earlier context.

Cheap fixes, independent of the cause:
- `resources: { vcpus: 1 }` in `agent/sandbox/sandbox.ts`, which halves memory.
- A shorter `idleTimeoutMs` (eve's default is 5 minutes).
- Deleting sandboxes idle for a week, so their snapshots don't sit for 30 days.

## Gateway left in production

Channel screening and voice-note transcription still call AI Gateway (see [field-notes.md](field-notes.md), eve). Screening could move to the inference endpoint. Transcription needs a model that takes audio, which an Anthropic-compatible endpoint doesn't serve.

## A subscription brain

The agent's model runs on the inference endpoint. Running it on a Claude subscription instead would mean headless Claude Code as the brain: Anthropic's terms allow a subscription only in Claude Code itself, not as the model inside eve. Not decided; check that eve is still the right host before reworking it. Codex through OpenCode is the other route, once its login can be lent to per-job machines.
