# API guide

Base URL: `http://127.0.0.1:8741`. API prefix: `/v1`.

The generated contract is [openapi.json](openapi.json). It is the source of truth for request and response schemas. `kiln openapi` regenerates it without starting the daemon. `/docs` serves the interactive reference; it is authenticated too, so use a bearer-capable client or your authenticated reverse proxy.

## Authentication and errors

Send `Authorization: Bearer <KILN_TOKEN>` on all API, schema, and documentation requests. The exception is `/v1/webhooks/github`, which requires a valid GitHub HMAC signature rather than a bearer token. `/healthz` is an unauthenticated liveness probe.

Treat the bearer token as host-code-execution access. There are no per-user roles. Do not put the token in query strings, workflow YAML, chat transcripts, or SSE URLs.

JSON mutations are limited to 1 MiB. Unexpected JSON properties are rejected. Common response codes:

| Code | Meaning |
|---|---|
| 200 | Operation accepted or completed; a run response does not mean its graph has completed |
| 400 | Malformed request or invalid stream cursor |
| 401 | Missing/invalid bearer token or webhook signature |
| 404 | Resource does not exist |
| 409 | State conflict, stale decision/revision, overlap, or idempotency-key payload conflict |
| 413 | Request exceeds the body limit |
| 422 | Schema or workflow validation failure |
| 500 | Internal persistence/dependency operation failed; inspect daemon logs |
| 503 | Webhook integration is not configured |

Typed REST endpoints return RFC 9457-style problem responses. Raw SSE/webhook/auth boundary errors return a small JSON `error` object. Avoid parsing error text for control flow; use status and the run's persisted state.

## Quick start

Start the daemon with a bearer token as described in the README, then use these requests as a minimal loop.

```sh
export KILN_URL=http://127.0.0.1:8741

# Register YAML. Its name becomes the workflow ID.
jq -Rs '{yaml: .}' examples/retry.yaml |
  curl --fail-with-body -sS "$KILN_URL/v1/workflows" \
    -H "Authorization: Bearer $KILN_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-

# Start a run. Repeating the same key and payload returns the same run.
curl --fail-with-body -sS "$KILN_URL/v1/runs" \
  -H "Authorization: Bearer $KILN_TOKEN" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"workflow_id":"repair-demo"}'

# Inspect pending human decisions.
curl -sS "$KILN_URL/v1/questions" -H "Authorization: Bearer $KILN_TOKEN"

# Answer the exact question returned above.
curl --fail-with-body -sS "$KILN_URL/v1/runs/RUN_ID/decisions" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"question_id":"QUESTION_ID","choice":"approve","comment":"Reviewed"}'

# Replay and follow events. Reconnect with Last-Event-ID.
curl -N "$KILN_URL/v1/runs/RUN_ID/stream" -H "Authorization: Bearer $KILN_TOKEN"
```

## Automations

An automation pins the current workflow revision plus exactly one trigger: a five-field UTC cron schedule or an exact event name. Saving it again repins the current definition.

```sh
# Every weekday at 09:00 UTC.
curl --fail-with-body -sS -X PUT "$KILN_URL/v1/automations/morning" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"workflow_id":"repair-demo","schedule":"0 9 * * 1-5","enabled":true}'

# An exact application event.
curl --fail-with-body -sS -X PUT "$KILN_URL/v1/automations/on-request" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"workflow_id":"repair-demo","event":"work.requested","enabled":true}'

# Dispatch the event. Use an Idempotency-Key for retries.
curl --fail-with-body -sS "$KILN_URL/v1/events" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: request-123' \
  -d '{"name":"work.requested","inputs":{"goal":"Fix the build"}}'

# Fire an enabled automation manually.
curl --fail-with-body -sS -X POST "$KILN_URL/v1/automations/morning/fire" \
  -H "Authorization: Bearer $KILN_TOKEN"
```

Only one active run per automation is allowed. Waiting and interrupted runs count as active. Overlapping event deliveries are skipped and reported; manual fires return 409. Missed cron ticks coalesce into one run on restart. There is no backlog replay. GitHub event automations also require `github_repository` and accept only `github.*` event names.

## Endpoint inventory

| Method | Path | Purpose |
|---|---|---|
| POST | `/workflows/validate` | Parse and validate `{yaml}` without saving; no provider connectivity probe |
| POST | `/workflows` | Register `{yaml, expected_revision?}`; name is the ID |
| GET | `/workflows` | List current definitions |
| GET / DELETE | `/workflows/{id}` | Inspect/delete a definition; pinned runs and automations remain |
| POST | `/runs` | Queue `{workflow_id, inputs?}` |
| GET | `/runs` | List summaries, optionally filter `status` |
| GET | `/runs/{id}` | Full pinned definition, inputs, outputs, attempts, cursor, workspace, and question |
| POST | `/runs/{id}/cancel` | Persist cancellation, then kill active process group |
| POST | `/runs/{id}/retry` | Explicit retry with `{acknowledge_side_effects:true}` |
| POST | `/runs/{id}/decisions` | Answer `{question_id, candidate_id?, choice, comment?}` |
| GET | `/questions` | List runs with pending human gates |
| GET | `/runs/{id}/events` | Replay events with `after` and `limit` |
| GET | `/runs/{id}/stream` | SSE replay/live tail |
| GET | `/runs/{id}/attempts/{attempt}/transcript` | Raw agent JSONL, including partial interrupted attempts |
| GET | `/runs/{id}/artifacts/{path}` | Download a private run artifact; supports nested paths |
| GET | `/runs/{id}/candidate/diff` | Selected, validated product diff; includes `truncated` |
| GET | `/runs/{id}/diff` | Tracked-file diff against pinned base; includes `truncated` |
| DELETE | `/runs/{id}/workspace` | Remove an inactive terminal run's worktree/directory |
| PUT | `/automations/{id}` | Save workflow ID, enabled flag, inputs, and cron or event trigger |
| GET | `/automations` | List automations and schedule/fire/skip telemetry |
| GET / DELETE | `/automations/{id}` | Inspect/delete a trigger; existing runs remain |
| POST | `/automations/{id}/fire` | Manually fire an enabled, non-overlapping automation |
| POST | `/events` | Dispatch `{name, inputs?, repository?}` |
| POST | `/webhooks/github` | Signed, repository-scoped GitHub delivery |
| GET | `/status` | Worker count, active operations, healthy flag, run counts |

List endpoints use `limit` (default 50, max 100) and `offset` (default 0). Runs are oldest first. Event pagination uses a monotonic integer cursor and a maximum limit of 1,000. IDs are opaque. Workflow and automation IDs are named identifiers; runs/questions/attempts use random IDs.

`GET /runs/{id}/diff` includes tracked modifications relative to the original base commit, including committed changes. Untracked files are not in a Git diff. It is bounded at 64 KiB; inspect the retained worktree when `truncated` is true.

Repository attempts expose `checkpoint_sha` and `finalized`. `node.executed` means the external result is durable; `node.finished` means its checkpoint and graph transition are finalized. Raw transcripts require bearer authentication and survive workspace cleanup. Agent final answers remain in `outputs`; JSONL includes the underlying model/tool events, not just the answer.

`run.candidate` contains the immutable publication snapshot: candidate ID, commit/tree/base/source hashes, paths selected/excluded, configured Git identity, check command/time, and title/body. The candidate diff excludes recovery residue and survives workspace cleanup. A question raised after preparation carries `candidate_id`; send it back with the exact question ID. A changed source or a decision bound to an older candidate blocks publication. Prepare and review a new candidate instead of approving by branch name.

Internal `artifact_file` output is downloadable through `/runs/{id}/artifacts/{path}`. Downloads require authentication, are confined to that run's artifact directory, and survive workspace cleanup. Directories and escaping symlinks are not served. Plans already exist in stored node outputs; artifact files are optional.

## Building a chat adapter

The daemon does not interpret natural-language requests. Keep that responsibility in the chat application:

1. Select/register a reviewed workflow definition.
2. Submit a run with structured string inputs. Use your durable chat action ID as `Idempotency-Key`.
3. Subscribe to the run's SSE stream, persisting the last event ID in the chat adapter.
4. On `human.question`, fetch the run and render its question and exact choices.
5. Post an explicit user choice with that question ID. A 409 means the question was already answered or replaced; refresh instead of guessing.
6. Show node failures, PR URLs, and terminal state. Ask for explicit confirmation before retrying `interrupted` runs.

Never convert repository text or model output directly into API mutations. Those are untrusted inputs to the chat adapter, not operator instructions.

## Idempotency

`POST /runs`, `POST /automations/{id}/fire`, and `POST /events` accept an optional `Idempotency-Key` header, up to 200 characters. Use it for every retried mutation.

- The same key and payload returns the original result/run ID.
- Reusing a run/event key with a different payload returns 409.
- Keys are scoped to the operation; manual fire keys are additionally scoped to the automation ID.
- The deduplication record and run creation commit in the same transaction.
- Keys currently have no expiry. Retention is operator-managed.
- Human answers use the pending question's ID as a compare-and-swap token. Duplicate answers intentionally return 409, not a second transition.

Updating a workflow changes only future direct submissions. Existing runs and automations retain their definitions. Supply `expected_revision` when updating a workflow to reject concurrent edits. Saving an automation again repins the current definition.

## Events and SSE

An event contains `id`, `run_id`, `type`, `time`, and `data`. Events and corresponding run checkpoints are committed atomically. IDs increase globally; gaps within one run are normal.

```text
id: 123
event: node.finished
data: {"id":123,"run_id":"...","type":"node.finished","time":"...","data":{...}}

```

Use `Last-Event-ID: 123` or `?after=123` to reconnect. The header takes precedence. The server replays all later events, then tails new records. Heartbeat comments keep idle connections alive. Streams stay open after terminal events until the client disconnects or daemon shuts down. Slow writes have a ten-second deadline.

Important types: `run.created`, `run.running`, `workspace.prepared`, `node.started`, `node.executed`, `node.finished`, `checkpoint.failed`, `run.recovered`, `human.question`, `human.answered`, `run.failed`, `run.canceled`, `run.interrupted`, `run.retried`, `workspace.cleaned`.

Terminal state may be carried by `node.finished` rather than a separate terminal event. Fetch the run when rendering authoritative state. Captured process output is delivered after the attempt completes, not as live token/log chunks.

## GitHub webhook contract

Headers: `X-Hub-Signature-256: sha256=<HMAC>`, `X-GitHub-Event`, and `X-GitHub-Delivery`. The signature covers the exact raw request bytes. Delivery ID reuse with altered content is rejected. No signature secret is stored in a workflow.

Event names are `github.<event>` or `github.<event>.<action>` when the payload has an action, for example `github.push` or `github.pull_request.opened`. Matching is exact. Every GitHub automation requires a matching `github_repository`; matching is case-insensitive for the repository slug.

Run inputs receive `event` (the raw JSON string) and `delivery_id`. These are data, never shell source. Responses contain `run_ids` and `skipped` automation IDs. An unmatched event is acknowledged with empty arrays. A valid delivery with an active automation run is acknowledged and skipped, not queued for later.

This version verifies HMAC and deduplicates delivery IDs but does not age out signatures. Protect the shared webhook secret and use HTTPS.
