# kiln

An always-on agent in its most primitive form: one Go process, one SQLite file, one folder of memory.

Five tables, one folder, three polling loops, one gate function. Every primitive is the same move: write intent to durable storage, then let a loop act on it.

```
Slack, POST /inbox/{user} ──> inbox ──> worker ──> run (model + tools) ──> outbox ──> dispatcher ──> Slack, webhook, stdout
       (adapters in)            ^                    │   │                              (adapters out)
               scheduler <── timers <────────────────┘   └──> memory folder
```

## The primitives

| Primitive | Irreducible idea | Here |
|---|---|---|
| Event inbox | Record that something happened before doing anything about it. | `inbox` table. The HTTP handler does one INSERT and returns 202. The worker takes every pending event for a user, runs the agent once, and marks them done only when the run commits. |
| Timers | A row with a due time that turns into an inbox event. | `timers` table. The scheduler never runs the agent; it only writes to the inbox. `interval_seconds` NULL is a one-off follow-up, otherwise a schedule. |
| Memory | Text that outlives the process, plus a table of contents that is always loaded. | `data/users/{user}/`: `instructions.md`, `index.md`, `notes/`, `transcripts/`. A run starts with the instructions and the index, nothing else. |
| Tasks | Work in flight is a row with notes and a wake time, written the moment it is taken on. | `tasks` table. `open_task` and `update_task` write at once, outside the run's transaction. An open task wakes the agent through the inbox until it is closed. |
| Permissions | One function between the model's tool call and its execution: allow, deny, or ask. | `gate()` in `internal/agent/gate.go`. Credentials are added by the tool executor and never enter the prompt. `ask` parks the session in `pending_approvals` and frees the worker. |
| Outbox | The agent records an intent to send; something else sends. | `outbox` table. `send_message` only inserts a row. The dispatcher delivers in order, paced, with backoff. |

A run is a transaction. Everything a run wants in the database (messages, timers, a parked approval) is buffered and committed together with marking its events done. A failed run leaves nothing behind and is retried.

Tasks are the deliberate exception. A task and its progress notes are saved as the agent writes them, so they outlive a run that fails, is cut off at its step limit, or dies with the process. The next run is a fresh session, but it opens with every open task and its notes, and carries on from there.

## Run it

```sh
cp .env.example .env   # set KILN_TOKEN, KILN_MODEL_KEY, KILN_MODEL
docker compose up --build
```

Or without Docker: `make build && (set -a; . ./.env; bin/kiln)`.

| Variable | Default | |
|---|---|---|
| `KILN_TOKEN` | required | Bearer token for the inbox endpoint, 32+ characters. |
| `KILN_MODEL` | required | Model id at the endpoint, e.g. `anthropic/claude-opus-5.5` on OpenRouter. |
| `KILN_MODEL_URL` | `https://openrouter.ai/api/v1` | Any OpenAI-compatible chat completions endpoint with tool calling: OpenRouter, OpenAI, Anthropic, Gemini, LM Studio, Ollama. |
| `KILN_MODEL_KEY` | empty | API key for the endpoint. Empty for local servers. |
| `KILN_MODEL_PARAMS` | empty | JSON object of extra request fields, sent as given. This is where vendor differences go, e.g. `{"reasoning":{"effort":"low"}}` on OpenRouter or `{"reasoning_effort":"low"}` on OpenAI. |
| `KILN_SLACK_BOT_TOKEN`, `KILN_SLACK_APP_TOKEN` | empty | Connects Slack. See [docs/slack.md](docs/slack.md). |
| `KILN_SLACK_USERS` | empty | Optional. Unset, everyone in the workspace shares one agent. Set it to restrict or split that. |
| `KILN_OUTBOX_URL` | empty | The channel of last resort. Outbox entries are POSTed here as `{"id","user_id","kind","body",...}`. Empty: JSON lines on stdout. |
| `KILN_DATA` | `data` | Database, memory folders, `origins.json`, lock file. |
| `KILN_ADDR` | `127.0.0.1:8080` | Listen address. |

## Talk to it

```sh
curl -H "Authorization: Bearer $KILN_TOKEN" \
  --data 'Remind me every weekday at 9 to review open PRs.' \
  http://127.0.0.1:8080/inbox/robert
```

The body is the event text. The reply arrives on the user's channel, not in the HTTP response: their Slack DM if they are mapped there, otherwise the webhook or stdout.

With Slack connected, talk to it there instead: DM the bot, @mention it, or address it by name in a channel it is in. Setup takes five minutes: [docs/slack.md](docs/slack.md).

Webhooks from other systems post to the same endpoint with `?source=github` (any short label). Only events with the default source, `user`, carry instructions or answer approvals. Everything else is presented to the model as data. The label is self-declared: anything holding the token can claim to be the user, so give the token only to callers you would let speak as you.

## Adapters

An adapter connects one channel. It does two things and holds no agent logic: it writes what it hears to the inbox, and it delivers what the outbox holds for it.

| Adapter | Hears | Sends |
|---|---|---|
| `slack` | DMs, @mentions, ambient channel messages, reactions on the agent's messages, clicks on Block Kit elements | Markdown messages, threaded replies, reactions, Block Kit layouts, approval prompts with buttons |
| `webhook` | nothing | every outbox entry as a JSON POST |
| `stdout` | nothing | every outbox entry as a JSON line |

Every event and message carries an address of the form `adapter:rest`, for example `slack:C0123:1731712345.000100`. The agent reads only the adapter name. A reply goes to the conversation its event came from; a message that answers nothing (a timer's result) goes to the user's default route, which is the first adapter that knows the user.

An adapter that can read its channel's history also implements `agent.Contexter`. The agent then opens each run with the recent messages around its events, read from the channel at that moment, never copied into kiln. This is how it sees what was said before it was woken.

To add a channel, implement `agent.Adapter` (five methods, documented in `internal/agent/adapter.go`) in its own package and append it to the list in `cmd/kiln/main.go`. Nothing in the agent changes. An adapter declares what its channel can do beyond text through `Features`: whether it takes reactions, and any extra `send_message` parameters, which the agent offers to the model and hands back untouched. Slack's `blocks` parameter is one of those.

## Give it HTTP access

Without `data/origins.json` the agent has no network tool. With it, `http_request` reaches exactly the listed origins, and the executor adds the listed headers:

```json
{
  "https://api.linear.app": { "Authorization": "lin_api_..." },
  "https://status.example.com": {}
}
```

The file must be mode 600. GET and HEAD run directly. Other methods need approval. Redirects are not followed. Header values are redacted from responses before the model sees them.

## Approvals

The gate asks for approval on any state-changing HTTP method and on any write to `instructions.md`. The run stops, and the outbox carries:

```
Approval needed: http_request {"method":"POST","url":"https://api.linear.app/graphql","body":"..."}
Why: it changes state on https://api.linear.app.
Reply "yes" to approve. Any other reply declines and is passed on as your answer.
```

In Slack the same prompt has Approve and Decline buttons. A button answers only the prompt it belongs to, and only for people who share the kiln user the prompt is for; a click on an old prompt changes nothing.

The reply is an ordinary inbox event. `yes`, `y`, `approve`, or `approved` runs the saved call exactly as shown and resumes the session. Anything else declines it and hands your text to the model. One approval per user can be open at a time; a later call that needs one is refused until you answer.

## Quiet by default

Only `send_message` reaches you. Runs started by timers and webhooks may end in silence. A run that includes a message from you gets one nudge if it is about to end with nothing sent, because chat-trained models tend to answer in plain text; after that, silence stands.

## Durable work

For anything longer than a few steps the agent opens a task and notes its progress as it goes: what is finished, what is next, where the results are.

- A run that fails is retried. The retry sees the open task and resumes from the notes instead of starting over.
- A run cut off at its limit of 40 model calls wakes again at once and continues. Without a task, it stops and tells you the work may be incomplete.
- An open task wakes the agent five minutes after its last progress note, unless the agent set a longer wait because it depends on someone else. Each wake-up that finds no progress doubles the wait, up to a day. A stalled task costs little and is never forgotten.
- A wake-up returns to the conversation the task was taken on in, so results land where the work was asked for.
- Closing a task as `done` or `dropped` ends the wake-ups.

```sh
sqlite3 data/kiln.db "SELECT id, user_id, state, title, datetime(wake_at, 'unixepoch', 'localtime'), idle_wakes FROM tasks ORDER BY id DESC LIMIT 20"
sqlite3 data/kiln.db "SELECT notes FROM tasks WHERE id = 1"
```

## Dreaming

A user's first event seeds a daily timer whose note tells the agent to review recent transcripts, curate its notes, and fix the index. It needs no machinery of its own. Cancel or reschedule it by asking the agent.

## Operating it

State is plain. Look at it.

```sh
sqlite3 data/kiln.db "SELECT id, user_id, source, origin, status, attempts FROM inbox ORDER BY id DESC LIMIT 20"
sqlite3 data/kiln.db "SELECT id, user_id, datetime(due_at, 'unixepoch'), interval_seconds, note FROM timers"
sqlite3 data/kiln.db "SELECT id, user_id, kind, address, status, attempts, body FROM outbox ORDER BY id DESC LIMIT 20"
sqlite3 data/kiln.db "SELECT id, user_id, tool_call FROM pending_approvals"
ls data/users/*/transcripts/
```

Failure handling:

- A failed run retries with backoff (30s doubling to 1h). After 8 attempts its events are marked `failed` and the user is told.
- A failed delivery retries on the same schedule. After 8 attempts the message is marked `failed` and the queue moves on. A delivery the channel can never accept (a deleted channel, an unknown emoji) fails at once.
- An event an adapter delivers twice is recorded once.
- The schema migrates itself on start. `PRAGMA user_version` holds the version.
- Delivery to the channel is at-least-once. Receivers deduplicate on `id`.
- A second process on the same data directory refuses to start.

## Limits of the primitive form

Each is the first upgrade when it starts to hurt, not before.

- One worker handles users one at a time. A long run for one user delays the others. Upgrade: a lock row per user and several workers.
- Every run is a fresh session. Memory files carry continuity, and each run opens with the agent's last eight exchanges from every place it is present, plus the channel's own recent history around the new events. Upgrade: compaction for sessions that must persist.
- The gate is a hard-coded deny list. Upgrade: a second model call that classifies risky calls.
- Credentials live in the executor's file. Upgrade: a real proxy, needed once the agent gets a shell.
- One token, self-declared sources. Upgrade: a token per source.
- Tool calls an interrupted run already made are repeated on retry. Reads and file writes are idempotent and database effects are transactional. Two things can double: a task progress note, which is harmless, and an approved HTTP call, only if the process dies in the instant between the call and saving its result.
- Open approvals do not expire.
- Tasks have no dependencies or priorities. They are a list of work in flight, not a tracker.
- Whether work is tracked as a task is the model's judgment. Work it chose not to track is not resumed.
- Messages are delivered when the run ends, not while it works. A reaction the agent adds to acknowledge a message arrives with the reply, not before it.

## Development

```sh
make check        # gofmt, vet, race tests, build
make docker-test  # the same in a clean container
```

Tests drive the three loops directly against a fake clock and a scripted OpenAI-compatible server. The Slack adapter is tested against a fake Web API and a real WebSocket. Nothing needs the network or a key.

One test is opt-in because it spends tokens: a real model driving the Slack adapter against the fake Slack, through a threaded reply, a reaction, a Block Kit message, an approval by button, and a channel where it must stay silent on chatter and answer when named. Run it after changing prompts, tools, or the adapter, on more than one vendor:

```sh
KILN_LIVE_MODEL=anthropic/claude-haiku-5.5 KILN_MODEL_KEY=... go test ./internal/slack -run TestLiveModel -v
```
