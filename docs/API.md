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

## Durable work

A work item is a durable objective, not an execution. Its title, objective, acceptance criteria, and dependencies are immutable. Dependencies must already exist when the item is created, so the dependency graph is acyclic. Each dependency must be completed before a linked run can start or the item can be completed. Canceled dependencies block their dependents.

Work starts `open` and stays open when runs fail or succeed. Only an explicit, evidence-backed completion request changes it to `completed`; cancellation changes it to `canceled`. There are no contract-edit, work-delete, automatic-completion, or attach-existing-run endpoints.

```sh
# Create the durable contract. Keep the returned work ID and integer revision.
curl --fail-with-body -sS "$KILN_URL/v1/work" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: repair-build-1' \
  -d '{"title":"Repair the build","objective":"Restore a passing build","acceptance_criteria":["Build and tests pass"],"handoff":{"next_action":"Reproduce the failing build"}}'

# Start a new execution linked to the contract at its current revision.
curl --fail-with-body -sS "$KILN_URL/v1/runs" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: repair-build-attempt-1' \
  -d '{"workflow_id":"repair-demo","work_id":"WORK_ID","work_revision":1}'

# Refresh before a mutation: starting the run increments the work revision.
curl -sS "$KILN_URL/v1/work/WORK_ID" -H "Authorization: Bearer $KILN_TOKEN"

# Replace the complete handoff, using the revision just read.
curl --fail-with-body -sS -X PUT "$KILN_URL/v1/work/WORK_ID/handoff" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expected_revision":2,"handoff":{"progress":"Reproduced the failure","failed_approaches":"Dependency refresh did not help","blockers":"","next_action":"Review the verification output"}}'

# Inspect linked run summaries and replay the separate work event history.
curl -sS "$KILN_URL/v1/work/WORK_ID/runs?limit=50&offset=0" -H "Authorization: Bearer $KILN_TOKEN"
curl -sS "$KILN_URL/v1/work/WORK_ID/events?after=0&limit=100" -H "Authorization: Bearer $KILN_TOKEN"

# After the latest run succeeds and becomes inactive, inspect its attempts.
curl -sS "$KILN_URL/v1/runs/RUN_ID" -H "Authorization: Bearer $KILN_TOKEN"

# Explicit operator approval, with one verification reference per criterion.
curl --fail-with-body -sS "$KILN_URL/v1/work/WORK_ID/complete" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"expected_revision":3,"run_id":"RUN_ID","approve":true,"summary":"Reviewed the successful build and tests","evidence":[{"criterion":1,"attempt_id":"VERIFICATION_ATTEMPT_ID"}]}'
```

The numeric revisions above assume no other work mutations. Handoff updates replace all four optional text fields, increment the revision, and reject stale `expected_revision` values with 409. Starting a linked run also uses compare-and-swap: send `work_id` and its current `work_revision` together. The response contains `work_id` and a pinned `work` snapshot at the incremented revision, including the contract, handoff, and previous run evidence when available. Later handoff updates do not rewrite that snapshot. Unlinked runs can still be submitted without either field; run summaries include optional `work_id`.

Handoff text records the operator's accepted progress, failed approaches, blockers, and next action. It is context, not an executable policy: use dependency IDs or workflow human gates for enforced blocking. Previous run outputs remain evidence rather than automatically accepted progress.

Only one linked execution can be outstanding. Queued, running, waiting, interrupted, or still-active terminal runs prevent a replacement. Handle an interrupted run explicitly: either retry it with `acknowledge_side_effects:true`, or cancel the run and wait for it to become inactive before starting a replacement. A failed or interrupted run cannot be retried after a newer run supersedes it or the work closes. A replacement run may use a different registered workflow, but the work contract remains unchanged.

Completion requires the latest linked run to be `succeeded` and inactive, `approve:true`, a nonempty summary, and exactly one evidence entry for each acceptance criterion. `criterion` is one-based. Every `attempt_id` must belong to that run and identify a successful, finalized `command` or `changeset` attempt with a finish time. Agent self-reports, failed or unfinished attempts, and attempts from older runs are not completion evidence. Changeset evidence must reference the current selected candidate. The stored completion records the verified node and any checkpoint/candidate identity; a succeeded run alone never completes work.

The server validates the evidence references and recorded execution outcomes; the operator decides whether those checks actually establish the criteria. This is an explicit attestation under the existing single-operator bearer-token trust model, not automatic semantic verification or a new role-based approval system. Replacement runs start with fresh workspaces; prior checkpoints and candidates are references, not automatically reapplied code.

To cancel inactive open work, send `POST /work/WORK_ID/cancel` with `{"expected_revision":CURRENT_REVISION,"reason":"No longer needed"}`. Canceling work does not cancel an outstanding run: cancel that run first and wait for it to become inactive. Completed and canceled work cannot be reopened, receive handoff updates, or start new runs. Refresh after any 409 rather than blindly repeating a mutation with a stale revision.

`GET /work` supports `status=open|completed|canceled`, `limit`, and `offset`. Work and linked run history are oldest first. Work events use `id`, `work_id`, `type`, `time`, and `data`; types include `work.created`, `work.handoff`, `work.run_created`, `work.completed`, and `work.canceled`. Use the last returned event ID as the next `after` cursor. This is a separate paginated history, not an SSE endpoint; execution events remain on the run endpoints.

The durable-work release transactionally migrates schema 3 storage to schema 4 while preserving existing runs. Do not downgrade the daemon against migrated storage; older binaries do not understand the work fields and must not rewrite its records.

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
| POST | `/work` | Create `{title, objective, acceptance_criteria, dependencies?, handoff?}` |
| GET | `/work` | List work contracts, optionally filter `status` |
| GET | `/work/{id}` | Inspect contract, current handoff/revision, latest run, and completion evidence |
| PUT | `/work/{id}/handoff` | Replace `{expected_revision, handoff}` using compare-and-swap |
| POST | `/work/{id}/complete` | Explicitly approve `{expected_revision, run_id, approve:true, summary, evidence}` |
| POST | `/work/{id}/cancel` | Cancel inactive open work with `{expected_revision, reason}` |
| GET | `/work/{id}/runs` | Paginated linked run summaries |
| GET | `/work/{id}/events` | Replay work events with `after` and `limit` |
| POST | `/runs` | Queue `{workflow_id, inputs?, work_id?, work_revision?}`; work fields must be paired |
| GET | `/runs` | List summaries, optionally filter `status` |
| GET | `/runs/{id}` | Full pinned definition, inputs, outputs, attempts, cursor, workspace, sandbox, and question |
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
| DELETE | `/runs/{id}/workspace` | Remove an inactive terminal run's worktree/directory and delete its remote machine |
| PUT | `/automations/{id}` | Save workflow ID, enabled flag, inputs, and cron or event trigger |
| GET | `/automations` | List automations and schedule/fire/skip telemetry |
| GET / DELETE | `/automations/{id}` | Inspect/delete a trigger; existing runs remain |
| POST | `/automations/{id}/fire` | Manually fire an enabled, non-overlapping automation |
| POST | `/events` | Dispatch `{name, inputs?, repository?}` |
| POST | `/webhooks/github` | Signed, repository-scoped GitHub delivery |
| GET | `/status` | Worker count, active operations, healthy flag, run counts |

List endpoints use `limit` (default 50, max 100) and `offset` (default 0). Runs and work are oldest first. Event pagination uses `after` (default 0), `limit` (default 100, max 1,000), and a monotonic integer cursor. IDs are opaque. Workflow and automation IDs are named identifiers; work/runs/questions/attempts use random IDs.

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

For requests that span multiple executions, create a work item first and link each new run with `work_id` and the current `work_revision`. Persist concise handoffs between attempts, show verification evidence to the operator, and post completion only after explicit approval. Do not treat a model's final answer or a run's `succeeded` status as authorization to complete work.

Never convert repository text or model output directly into API mutations. Those are untrusted inputs to the chat adapter, not operator instructions.

## Idempotency

`POST /work`, `POST /runs`, `POST /automations/{id}/fire`, and `POST /events` accept an optional `Idempotency-Key` header, up to 200 characters. Use it when retrying these creation/dispatch requests. Handoff, completion, and cancellation use work revisions instead.

- The same key and payload resolves to the original created resource/result. Work creation replays return that work item's current state.
- Reusing a work/run/event key with a different payload returns 409.
- Keys are scoped to the operation; manual fire keys are additionally scoped to the automation ID.
- The deduplication record and work/run creation commit in the same transaction.
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

Important types: `run.created`, `run.running`, `workspace.prepared`, `node.started`, `node.executed`, `node.finished`, `checkpoint.failed`, `run.recovered`, `human.question`, `human.answered`, `run.failed`, `run.canceled`, `run.interrupted`, `run.retried`, `sandbox.stopped`, `sandbox.stop_failed`, `workspace.cleaned`.

Sandbox runs record their machine in `run.sandbox` (`provider`, `id`, `type`, `home`, and `url` for agent37 instances) and in `workspace.prepared`; each remote attempt result carries `sandbox`. `sandbox.stopped` follows the terminal transition, and `workspace.cleaned` includes the deleted machine ID.

Terminal state may be carried by `node.finished` rather than a separate terminal event. Fetch the run when rendering authoritative state. Captured process output is delivered after the attempt completes, not as live token/log chunks.

## GitHub webhook contract

Headers: `X-Hub-Signature-256: sha256=<HMAC>`, `X-GitHub-Event`, and `X-GitHub-Delivery`. The signature covers the exact raw request bytes. Delivery ID reuse with altered content is rejected. No signature secret is stored in a workflow.

Event names are `github.<event>` or `github.<event>.<action>` when the payload has an action, for example `github.push` or `github.pull_request.opened`. Matching is exact. Every GitHub automation requires a matching `github_repository`; matching is case-insensitive for the repository slug.

Run inputs receive `event` (the raw JSON string) and `delivery_id`. These are data, never shell source. Responses contain `run_ids` and `skipped` automation IDs. An unmatched event is acknowledged with empty arrays. A valid delivery with an active automation run is acknowledged and skipped, not queued for later.

This version verifies HMAC and deduplicates delivery IDs but does not age out signatures. Protect the shared webhook secret and use HTTPS.
