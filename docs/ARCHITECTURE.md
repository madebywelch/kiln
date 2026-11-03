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
- **One remote machine per run, not per node:** a `sandbox` workflow runs its commands, agents, and candidate checks on one boat.dev or agent37 machine while Git history, checkpoints, approvals, and publication stay on the host. The machine is an execution target, not a second control plane: no scheduler, lease, or database state lives there, each provider's HTTP API is driven directly rather than through an SDK, and the provider-specific code is a small transport behind one interface (create, ready, exec, launch, upload, download, stop, remove).

Fabro's explicit graphs, gates, and execution log were useful reference points. kiln is an independent YAML design, not a Fabro graph parser or API-compatible fork. References: [Fabro architecture](https://github.com/fabro-sh/fabro/blob/main/docs/public/reference/architecture.mdx), [graph language](https://github.com/fabro-sh/fabro/blob/main/docs/public/reference/dot-language.mdx).

[Gas City](https://github.com/gastownhall/gascity/blob/main/docs/getting-started/how-gas-city-works.md) and [Beads](https://github.com/gastownhall/beads) provide another useful reliability principle: durable work must outlive the session executing it. KILN applies that principle through pinned runs, journaled attempts, persisted human questions, execution leases, and checkpoint reconciliation. Recovery must distinguish a known result from an uncertain external side effect; a generic server error is not proof that a command never ran. This does not require adopting a fleet scheduler or replacing the single-host SQLite store with a distributed work tracker.

## State machine

Durable work is the obligation; a workflow run is one execution trying to advance it. Work has `open`, `completed`, and `canceled` states independent of run state. Its objective, ordered acceptance criteria, and dependency IDs are immutable. Dependencies must already exist at creation, and cannot later be changed, so the dependency graph cannot acquire cycles. Only completed dependencies release a work item for execution; a successful dependency run is not sufficient.

Work creation, handoff updates, run attachment, completion, and cancellation have durable audit events. Handoff updates and run creation compare the current work revision. Run creation atomically claims the work, pins its context, appends both work/run events, and records idempotency. One latest run owns execution: queued, running, waiting, interrupted, and still-settling runs block a replacement. Retries of superseded runs or closed work are rejected. A failed or canceled run leaves its work open for another explicitly submitted run; there is no autonomous replanner or fleet scheduler.

Each linked run pins the objective, acceptance criteria, operator-written handoff, and the preceding run's status, last result, candidate, and checkpoint reference. The context is available to local and remote workers in `KILN_CONTEXT_FILE`, in `.work` templates, and through a bounded agent-prompt preview. Later handoff edits do not rewrite a running worker's contract. Prior outputs are evidence, not instructions. Full linked-run history remains paginated through the API; snapshots do not recursively embed earlier contexts. Replacement runs get fresh workspaces: retained checkpoints and candidates are evidence, not automatically applied code changes.

Completion is an explicit operator attestation, not an agent tool result or graph outcome. It requires the latest linked run to have succeeded and stopped, explicit approval, a summary, and one reference per criterion to a successful finalized `command` or `changeset` attempt in that run. Changeset evidence must name the current candidate. The server verifies these references and records the checkpoint/candidate identities; the operator judges whether the checks actually establish the requested criteria. Human gates and publication checks inside the workflow remain unchanged. Workspace cleanup does not delete the obligation, run history, or completion record.

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

Remote launch responses that cannot confirm execution, and failures to collect the remote workspace, also leave the run `interrupted`. They do not follow a failure edge or automatically replay the node, including after restart. Inspect the sandbox and preserve any uncollected changes before retrying: retry can synchronize the host workspace back to the sandbox. Generic server errors do not trigger automatic command replay; explicit safe refusals still permit transport retries. Output-follow failures attempt to terminate the detached process, and synchronization refuses a live remote execution lease before modifying files. Termination is best-effort when the provider cannot be reached.

## Persistence and concurrency

The database has four responsibilities:

- `documents`: work contracts, workflow definitions, run snapshots, automations. JSON snapshots are bounded by graph/attempt limits and make a pinned definition self-contained. Expression indexes on kind, status and creation time support listings and overlap checks; a work-ID/creation index supports paginated execution history.
- `events`: append-only transition records indexed by run and cursor.
- `dedup`: request fingerprints and original result IDs, committed with run creation.
- `meta`: schema version; an unknown version prevents startup.

All engine mutations are serialized by one mutex. A filesystem advisory lock rejects a second daemon for the same data directory. SQLite uses one connection. External execution happens outside the engine mutex. Repository preparation and publication use a separate Git mutex; different runs still execute their commands/models concurrently.

Startup validates schema metadata before changing tables, indexes, or journal mode. An existing database must contain exactly one supported version row; missing, malformed, or incompatible metadata is rejected without initializing over it. Only an empty database is initialized as new state. Schema 3 is migrated to schema 4 in a transaction with the work-history index; existing JSON documents, events, and idempotency records are preserved. The version bump prevents older binaries from rewriting linked runs without their work context. Migration failure rolls back DDL and the version marker together.

Cancellation commits state before signaling the process group. A late worker result can add attempt evidence but cannot change a canceled run to success. A persistence failure stops dispatch and cancels active operations; it appears in `/v1/status` and structured logs. Restart and inspect interrupted runs after resolving the storage fault.

This is intentionally single-process. Mounting the same data directory on multiple machines, using SQLite on a network filesystem, or running multiple active replicas is unsupported.

## Git lifecycle

Each configured repository gets a bare cache keyed by repository identity. A run fetches its base, records the exact commit, and creates a unique branch and worktree. A private base ref lets preparation recover an existing run worktree without resetting its contents after interruption.

For every completed stage attempt, `git commit-tree` snapshots the index with the current HEAD as parent. A single `git update-ref --stdin` transaction advances the run branch and creates `refs/kiln/checkpoints/<run>/<attempt>`. On recovery, that ref reconciles a lost database write; changed branch/worktree state fails closed. Empty commits and failed attempts remain in the chain. Cleanup preserves audit refs even after deleting a worktree/branch. This recovery branch and its checkpoint ancestry are private and are never pushed.

A `changeset` node classifies every base-relative changed path as selected or excluded, rejecting unclassified changes. An alternate index builds a product tree from the pinned base plus selected entries, including deletions and binary/mode changes. `commit-tree` uses only the base as parent. The candidate is rooted at `refs/kiln/candidates/<run>/<attempt>`, tested in a fresh detached worktree, and journaled with the node result. Unfinished validation never becomes an active publishable candidate. On a crash, a known journaled result reconciles its ordinary checkpoint; an unknown attempt requires explicit retry with a new candidate ID. Candidate refs keep even partial preparation evidence private; there is no automatic retention/GC policy.

Questions reached after preparation bind the candidate ID. Publication checks the source tree still matches, verifies the stored candidate ref/tree/parent, and rejects a stale bound decision. The PR operation verifies every effective fetch/push URL of `origin` against the configured GitHub repository. It pushes one explicit commit to a separate `<authenticated-github-user>/<short-topic>` branch pinned during candidate preparation, with tag following and mirror behavior disabled. An expected-empty `--force-with-lease=<ref>:` makes branch creation conditional on absence; it cannot overwrite another writer. Existing remote content must match exactly. Matching open PR lookup supports explicit retry; changed heads or closed/merged matches fail. Git and GitHub PR creation are not one atomic operation.

Plans, transcripts, review notes and command context belong outside worktrees. LLM `artifact_file` writes into private per-run storage; agents receive the same location as `KILN_ARTIFACT_DIR`. This is context and publication hygiene, not a filesystem security sandbox. Internal artifacts and candidate diff remain available through authenticated endpoints after workspace cleanup.

Cleanup is explicit and only permitted after the worker has stopped and the run is terminal. Audit data remains. No automated remote branch deletion or PR merge is performed.

## Remote machines

A run with a `sandbox` block gets one machine during workspace preparation. On boat it is created with an idempotency key derived from the run ID so a lost response never provisions a second billable machine; agent37 creates synchronously. Preparation journals the machine ID even when it fails, and a retried preparation reuses it. Node execution brings the machine to a running state (resuming an archived one), moves its auto-stop deadline past the node timeout, and synchronizes the checkout through Git: a bundle of the objects the machine lacks goes out with the per-attempt files and artifacts in one tar; after the node, the machine stages its working tree, commits it with the pre-node commit as parent, and returns a bundle of that commit. The host fetches it and resets index and working tree to that tree, so the normal checkpoint records the remote result with the usual parent. Candidate validation adds a detached worktree of the candidate commit on the machine and removes it afterwards.

Every remote process runs through a wrapper script: it refuses to start while a previous attempt's wrapper is alive (a per-run lease inside the machine, exit code 75), sources the attempt environment from a file it removes immediately, and runs the program with `env -i` and only the machine's `PATH`, `HOME`, and locale plus the node's declared variables. The wrapper runs detached. On boat the host follows its output through the provider's attach stream, reconnecting from byte offsets as the protocol requires; on agent37, whose exec call is synchronous, the wrapper runs in its own session with output in files that the host polls in bounded base64 chunks. Either way the process group is terminated through the provider on timeout, cancellation, or daemon shutdown. Output limits, transcript capture, semantic agent completion checks, and checkpoints are the same code as for local attempts.

Terminal runs stop their machine; workspace cleanup deletes it. Waiting and interrupted runs keep it, bounded by the provider's idle auto-stop (boat) or auto-sleep (agent37), and the next node resumes, wakes, or starts it. The daemon never writes credentials into provider-side state beyond the per-attempt environment file, and it does not hand machines the provider account's secrets; the inference key a workflow already uses is the only credential a remote agent receives.

## Automations

A saved automation pins a definition and either a five-field UTC cron expression or an exact event name. Creation of a scheduled run and advancement of its next cursor share one transaction. Missed ticks coalesce; overlapping work is skipped. The definition records the latest fire/run and skipped time.

Event delivery deduplication and creation of all matching runs share a transaction. A replay returns the same run IDs. A running, queued, waiting, or interrupted run blocks another run of the same automation. This avoids quietly piling up work behind a human decision.

## Boundaries

- Worktrees isolate changes, not permissions. Commands are trusted code.
- A remote machine isolates the daemon host from a run's commands, not the run from its own credentials: anything in the process environment is readable there. Codex subscription credentials never leave the host.
- HTTP bearer authentication is single-operator, not per-resource authorization.
- Global concurrency and visit/time/token limits bound individual execution, but there is no multi-tenant admission quota, disk quota, or aggregate cost budget.
- Final output is checkpointed at attempt completion. Raw agent JSONL is captured during execution and downloadable via the authenticated API, including partial records. SSE streams lifecycle events, not individual token deltas.
- Sequential graph traversal is not parallel fan-out/join. Adding that requires explicit branch tokens and join semantics, not a second goroutine around the current cursor.
- Model HTTP nodes are one-shot text calls, not tool-using agents. Agent nodes delegate that work to an installed CLI.
- No automatic archival or dedup-key expiry. Back up and manage the data directory as private application state.

These boundaries keep the first implementation deployable and auditable. Distributed leases, richer event filters, per-node containers, and branch/join execution should be separate changes with their own failure models.
