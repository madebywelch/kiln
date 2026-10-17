# Architecture

## Design decisions

The goal is not another chat loop. It is a small, inspectable control plane that runs reviewed procedures on a remote machine.

- **Go instead of a runtime bundle:** native Linux/macOS binaries, bounded worker concurrency, direct process control, standard HTTP tooling. No Node/Python runtime for the daemon itself.
- **SQLite instead of a service fleet:** one installation owns its queue, checkpoints, human questions, automation cursors, deduplication records, and audit events. WAL plus synchronous FULL commits. No Redis/Postgres dependency.
- **Typed HTTP handlers:** Huma generates OpenAPI and JSON schemas from the same types used by the server. A chat adapter can discover the API without scraping CLI output.
- **Explicit outcomes instead of an expression language:** commands/models return success or failure; humans choose named outcomes. The graph determines recovery. No hidden model fallback or automatic command replay.
- **One cursor per run:** supports branching and cycles with predictable checkpoint boundaries. Concurrent runs are supported; concurrent branches within a run are deliberately not.
- **Two fixed agent backends:** Pi owns the OpenRouter tool loop and selected skills/MCP; Codex owns subscription inference and its native tools. No plugin/runtime matrix. Single-call model nodes remain a separate HTTP adapter. Pi Durable is experimental and would duplicate the scheduler/recovery boundary, so KILN uses Pi's JSON subprocess protocol.
- **Immutable run/automation snapshots:** editing a workflow cannot silently alter in-flight work or an unattended schedule.

Fabro's explicit graphs, gates, and execution log were useful reference points. kiln is an independent YAML design, not a Fabro graph parser or API-compatible fork. References: [Fabro architecture](https://github.com/fabro-sh/fabro/blob/main/docs/public/reference/architecture.mdx), [graph language](https://github.com/fabro-sh/fabro/blob/main/docs/public/reference/dot-language.mdx).

## State machine

```text
                          human node
queued → running ─────────────────────→ waiting
  ↑         │                              │
  │         │ node completed               │ exact question answered
  └─────────┴──────────────────────────────┘
            │
            ├─ end reached → succeeded
            ├─ unrouted failure / budget exhausted → failed
            ├─ explicit cancellation → canceled
            └─ daemon interruption → interrupted

failed / interrupted ── explicit retry ──→ queued
```

A worker executes one checkpointed unit at a time. Workspace preparation is its own unit, followed by graph nodes. A 100 ms scheduler dispatches queued runs up to the configured worker limit. Human gates do not occupy workers.

Before an external operation, KILN persists its running status and attempt. Afterward it journals the result/output as `node.executed`, creates the Git checkpoint, then atomically persists its SHA, finalized marker, next cursor, and `node.finished` event. A crash before the result journal is ambiguous: startup marks it `interrupted` for explicit operator recovery. A crash after that journal safely resumes checkpoint reconciliation without repeating the external operation. Queued runs and pending human gates remain durable.

Subprocesses inherit a per-run file-descriptor lease. If a child survives a hard daemon exit and retains that descriptor, retry and cleanup are blocked until it exits. The lock is acquired before process creation, avoiding a PID-recording crash window. This is a cooperative guard, not a sandbox: programs can deliberately close inherited descriptors. Production service managers must still clean up the process cgroup.

The operator can inspect the last attempt and worktree, then explicitly retry with acknowledgement that side effects may repeat. There is no claim of exactly-once command/model/PR execution.

## Persistence and concurrency

The database has four responsibilities:

- `documents`: workflow definitions, run snapshots, automations. JSON snapshots are bounded by graph/attempt limits and make a pinned definition self-contained.
- `events`: append-only transition records indexed by run and cursor.
- `dedup`: request fingerprints and original result IDs, committed with run creation.
- `meta`: schema version; an unknown version prevents startup.

All engine mutations are serialized by one mutex. A filesystem advisory lock rejects a second daemon for the same data directory. SQLite uses one connection. External execution happens outside the engine mutex. Repository preparation and publication use a separate Git mutex; different runs still execute their commands/models concurrently.

Cancellation commits state before signaling the process group. A late worker result can add attempt evidence but cannot change a canceled run to success. A persistence failure stops dispatch and cancels active operations; it appears in `/v1/status` and structured logs. Restart and inspect interrupted runs after resolving the storage fault.

This is intentionally single-process. Mounting the same data directory on multiple machines, using SQLite on a network filesystem, or running multiple active replicas is unsupported.

## Git lifecycle

Each configured repository gets a bare cache keyed by repository identity. A run fetches its base, records the exact commit, and creates a unique branch and worktree. A private base ref lets preparation recover an existing run worktree without resetting its contents after interruption.

For every completed stage attempt, `git commit-tree` snapshots the index with the current HEAD as parent. A single `git update-ref --stdin` transaction advances the run branch and creates `refs/kiln/checkpoints/<run>/<attempt>`. On recovery, that ref reconciles a lost database write; changed branch/worktree state fails closed. Empty commits and failed attempts remain in the chain. Cleanup preserves audit refs even after deleting a worktree/branch. This recovery branch and its checkpoint ancestry are private and are never pushed.

A `changeset` node classifies every base-relative changed path as selected or excluded, rejecting unclassified changes. An alternate index builds a product tree from the pinned base plus selected entries, including deletions and binary/mode changes. `commit-tree` uses only the base as parent. The candidate is rooted at `refs/kiln/candidates/<run>/<attempt>`, tested in a fresh detached worktree, and journaled with the node result. Unfinished validation never becomes an active publishable candidate. On a crash, a known journaled result reconciles its ordinary checkpoint; an unknown attempt requires explicit retry with a new candidate ID. Candidate refs keep even partial preparation evidence private; there is no automatic retention/GC policy.

Questions reached after preparation bind the candidate ID. Publication checks the source tree still matches, verifies the stored candidate ref/tree/parent, and rejects a stale bound decision. The PR operation verifies every effective fetch/push URL of `origin` against the configured GitHub repository. It pushes one explicit commit to a separate `<authenticated-github-user>/<short-topic>` branch pinned during candidate preparation, with tag following and mirror behavior disabled. An expected-empty `--force-with-lease=<ref>:` makes branch creation conditional on absence; it cannot overwrite another writer. Existing remote content must match exactly. Matching open PR lookup supports explicit retry; changed heads or closed/merged matches fail. Git and GitHub PR creation are not one atomic operation.

Plans, transcripts, review notes and command context belong outside worktrees. LLM `artifact_file` writes into private per-run storage; agents receive the same location as `KILN_ARTIFACT_DIR`. This is context and publication hygiene, not a filesystem security sandbox. Internal artifacts and candidate diff remain available through authenticated endpoints after workspace cleanup.

Cleanup is explicit and only permitted after the worker has stopped and the run is terminal. Audit data remains. No automated remote branch deletion or PR merge is performed.

## Automations

A saved automation pins a definition and either a five-field UTC cron expression or an exact event name. Creation of a scheduled run and advancement of its next cursor share one transaction. Missed ticks coalesce; overlapping work is skipped. The definition records the latest fire/run and skipped time.

Event delivery deduplication and creation of all matching runs share a transaction. A replay returns the same run IDs. A running, queued, waiting, or interrupted run blocks another run of the same automation. This avoids quietly piling up work behind a human decision.

## Boundaries

- Worktrees isolate changes, not permissions. Commands are trusted code.
- HTTP bearer authentication is single-operator, not per-resource authorization.
- Global concurrency and visit/time/token limits bound individual execution, but there is no multi-tenant admission quota, disk quota, or aggregate cost budget.
- Final output is checkpointed at attempt completion. Raw agent JSONL is captured during execution and downloadable via the authenticated API, including partial records. SSE streams lifecycle events, not individual token deltas.
- Sequential graph traversal is not parallel fan-out/join. Adding that requires explicit branch tokens and join semantics, not a second goroutine around the current cursor.
- Model HTTP nodes are one-shot text calls, not tool-using agents. Agent nodes delegate that work to an installed CLI.
- No automatic archival or dedup-key expiry. Back up and manage the data directory as private application state.

These boundaries keep the first implementation deployable and auditable. Distributed leases, richer event filters, per-node containers, and branch/join execution should be separate changes with their own failure models.
