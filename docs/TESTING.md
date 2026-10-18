# Testing and acceptance evidence

## Deterministic suite

```sh
make check
make docker-test
make docker-smoke
```

The suite uses temporary directories, disposable local Git repositories, mocked HTTP inference, and an in-process HTTP server. It never needs provider credentials or remote repository access. Tests cover:

- Invalid/ambiguous YAML, unknown fields, duplicate keys, extra documents, graph reachability, edge targets, outcome names, time/visit limits, and strict templates.
- Failed commands routed through repair loops; global and per-node budget exhaustion.
- Timeout and process-group cancellation, including a delayed grandchild that must not write after cancellation.
- Inherited execution leases, orphan retry prevention, and transient fork/exec descriptor inheritance under concurrency.
- Durable human questions, stale/duplicate decisions, explicit rejection, and restart recovery.
- Concurrent idempotent run creation and content-pinned definitions.
- Atomic rollback of state, events, and deduplication records.
- Injected SQLite write failures that stop dispatch and produce internal errors rather than validation errors.
- Isolated worktrees, base-relative diffs, preservation of modified worktrees during preparation recovery, and idempotent cleanup after a lost checkpoint.
- Verification of every origin push URL, including a second unauthorized destination.
- Open/closed/merged PR response handling.
- Provider errors, malformed/truncated responses, missing credentials, timeouts, usage accounting, and confined file writes.
- Minimal subprocess environments, shell-injection-resistant input handling, output limits, and large context files that avoid OS environment limits.
- Bearer authentication, body limits, API schemas, cursor replay, SSE disconnects, signed GitHub webhooks, repository scoping, and delivery deduplication.
- Cron cursor advancement, missed-tick coalescing, pinned automation revisions, overlap prevention, and disabled automations.
- Remote machines against in-process fakes of the boat.dev and agent37 APIs that execute commands in a temporary home. Boat: idempotent creation with retried transient refusals and a non-retried billing refusal, no-env and monitoring-off requests, auto-stop extension, Git bundle synchronization of modifications, additions, deletions, and ignored files, artifact mirroring in both directions, failed-attempt checkpoints, timeout and daemon-shutdown termination of the remote process group, resume of an archived machine, the in-machine lease refusing a surviving process, Pi configuration and transcript capture with machine-side paths, candidate validation in a remote worktree, stop at terminal state, and deletion on cleanup. agent37: create request shape with template, type, shape, region, auto-sleep and run tag, output that spans several poll chunks arriving byte-exact in a transcript and bounded in a command result, termination of the detached process group on timeout, transparent wake of a sleeping instance versus an explicit start of a stopped one, template version pins, stop at terminal state, deletion on cleanup, and a non-retried balance refusal.

Publication tests prove that unclassified residue blocks preparation; excluded files and prior caches are absent from a fresh validation checkout; binary files, mode changes, symlinks, literal bracket paths, file/directory replacements and deletions are selected correctly; configured identity is honored; missing identity fails; stale decisions/source changes block publication; internal artifact downloads are confined/authenticated; and cleanup retains evidence. A real local Git transport test injects competing branch creation, mirror/tag configuration and retries, then inspects the remote object database to prove private commits/files/tags were not sent.

The suite also covers per-stage Git audit commits, failed/no-op stages, retained refs, reconciliation on both sides of the Git/database crash window, Pi/Codex completion protocols, subprocess bounds, selected skills/MCP, private configuration, and authenticated transcript access.

For a no-charge integration test using the real Pi runtime and stdio MCP against a local inference fixture:

```sh
npm ci --prefix harness
PATH="$PWD/harness/node_modules/.bin:$PATH" KILN_PI_INTEGRATION=1 go test -race ./...
```

CI runs this integration as well as the ordinary deterministic suite. Live provider requests never run in CI.

Verification includes the real-Pi/local-inference integration and race detector. The clean-publication baseline also passed ten consecutive factory-suite runs. Branch-naming coverage checks authenticated-user namespaces, bounded safe title slugs, identity lookup failures, rejection of malformed namespaces, and stable branches across retry/authentication changes. The clean Linux test image and non-root runtime smoke passed; the latter verified both pinned agent executable versions.

A clean Linux build/test ran in Docker with Go 1.27.2. The runtime image passed an HTTP smoke test as UID 10001, including repair, human approval, status, and workspace cleanup. The smoke client runs over loopback inside a read-only container with capabilities dropped, independent of host VM port-forwarding configuration. It also checks the mise-managed defaults (Node, pnpm, Go, Rust 1.99.0) under a minimal environment and a cold isolated HOME, including from a login shell, builds/tests/formats/lints/runs a dependency-free Cargo project offline, compiles and executes C/C++ programs, and resolves Tauri's development libraries through `pkg-config`. Compiler files must remain non-writable by the service account. CI also runs `container_smoke.py --sandbox --network` on native Linux with the same seccomp and AppArmor profiles as the hardened reference deployment; `--network` additionally installs a pinned Node version the image does not carry and proves the default is unaffected. The sandbox stage tests a cold isolated HOME, offline resolution of a repository's `packageManager` pin, Node's default piped Git subprocesses, HTTP/HTTPS proxy denials, blocked direct TCP egress, writes permitted in the configured cache and private home, and denied writes elsewhere.

```sh
# Select an already-running Docker engine without changing global configuration.
DOCKER_CONTEXT=colima make docker-test
DOCKER_CONTEXT=colima make docker-smoke
```

## Live multi-provider acceptance

This test is explicitly opt-in and billable. It invokes OpenRouter, runs the authenticated Codex CLI, pushes a GitHub branch, and creates a draft PR. It refuses a public repository.

Prerequisites:

- Build `bin/kiln` with `make build`.
- `OPENROUTER_API_KEY` is present in the environment.
- `gh auth status` and `codex login status` succeed under the same account that launches the daemon.
- A private, disposable GitHub repository has the contents of `testdata/intervals/` on `main`.
- The machine has Python 3, Git identity, `gh`, Pi 1.3.0 (Node 22.19+), and Codex 0.162.1.

Example fixture setup, if you need a fresh repository:

```sh
fixture=$(mktemp -d)
cp -R testdata/intervals/. "$fixture/"
git -C "$fixture" init -b main
git -C "$fixture" add .
git -C "$fixture" commit -m 'test: seed interval repair fixture'
git -C "$fixture" remote -v  # Confirm this is a new repository with no origin.
gh repo create OWNER/kiln-acceptance-UNIQUE --private \
  --source "$fixture" --remote origin --push
```

Run:

```sh
python3 scripts/live_acceptance.py \
  --repo OWNER/kiln-acceptance-UNIQUE \
  --reviewer-model <codex-model> \
  --artifacts .kiln/live-UNIQUE
```

The artifacts directory must be fresh. The script starts a local authenticated daemon with random test-only credentials, registers the 12-node graph, waits for the real reviewer and human gate, restarts the daemon, simulates an explicit acceptance-test approval through the API, verifies stale-answer rejection, and waits for a draft PR. It verifies one Conventional Commit directly on the pinned base, exact selected files, configured Git author, and the configured PR title/body. It then tests signed webhook deliveries and an actual minute-boundary cron tick using the deterministic workflow. The daemon stops in a `finally` block. Review artifacts and workspaces remain; no token is written into those artifacts.

The human gate in this test is deliberately answered by the test driver. Production runs wait for the real operator/chat adapter.

### What a live acceptance verifies

A successful run should demonstrate:

- One Conventional Commit directly on the pinned base, with the configured author/committer and only the selected files.
- Candidate validation in a clean checkout, with the bound human question preserved across a daemon restart.
- Real inference through OpenRouter, Pi's tool loop, and independent Codex review.
- Failing builds, repair loops, an incorrect repair routed through another attempt, and reviewer failure reaching a human gate rather than silently switching models.
- Git audit commits, branch publication, draft PR creation, and a concise configured PR body.
- Signed webhooks, delivery deduplication, signature rejection, an actual cron firing, overlap rejection, and cancellation of a waiting run.
- Durable event replay and authenticated transcript/artifact retrieval.

Safety does not depend on agent instructions: any unclassified residue blocks candidate preparation. Publication uses an expected-absent ref lease, so a competing branch creation fails rather than overwriting it. Product commits require an explicitly configured Git identity.

### Sandbox acceptance

The sandbox acceptance is billable. It needs `BOAT_API_KEY` for an account with an active plan (a key without one fails with `billing_required`), or `AGENT37_API_KEY` for a funded workspace. It makes no remote Git writes:

```sh
python3 scripts/sandbox_acceptance.py --artifacts .kiln/sandbox-UNIQUE                     # boat, Pi repair via OPENROUTER_API_KEY
python3 scripts/sandbox_acceptance.py --artifacts .kiln/sandbox-UNIQUE --provider agent37  # agent37, default template agent37-pi
python3 scripts/sandbox_acceptance.py --artifacts .kiln/sandbox-UNIQUE --no-agent          # deterministic command repair
```

It runs a failing build, a repair, a passing build, and candidate validation on one machine, checks the machine stays running at the human gate, verifies remote attempt results name the machine and every attempt has a checkpoint, downloads a remote artifact and the candidate diff, confirms the machine is archived once the run succeeds, and confirms workspace cleanup deletes it.

The acceptance passed on 2026-10-18 against a `small` trial machine: the base image's Pi 1.3.0 (the pinned version) completed the JSON protocol with DeepSeek over OpenRouter (12 turns, 11 tool calls), the whole graph including the human gate took under three minutes, and the account listed no sandboxes afterwards. A separate live check stopped the machine at a human gate through the provider API and confirmed the daemon resumed it for the next node with the ignored build cache intact.

The agent37 acceptance passed on 2026-10-18 against a `default` 2 vCPU instance of the stock `agent37-pi` template (image tag 2026.10.11a, gVisor kernel): its Pi 1.1.0 accepted the pinned harness's flags and JSON protocol with DeepSeek over OpenRouter (8 turns, 7 tool calls), the detached wrapper and chunked output polling delivered every attempt, the instance was stopped at terminal state and deleted on cleanup, and the workspace's other instances were untouched.

### Scoped agent acceptance

The scoped resource acceptance uses a disposable **local** repository and makes no remote writes:

```sh
python3 scripts/agent_acceptance.py --artifacts .kiln/scoped-agent-UNIQUE
```

It loads a named repository skill, calls a selected MCP tool, reads and edits code, runs the tests, passes a human gate, downloads its transcript through the API, and retains the run's Git checkpoints. An unselected deliberately invalid MCP command must never be loaded. Pi usage is recorded, but its catalog cost is not reported as provider billing.

Acceptance artifacts are local snapshots and are ignored by Git. Schema changes require fresh state for new runs; do not reopen an old database with a newer binary.

## Reproducing targeted failures

```sh
go test -race ./internal/factory -run TestRecoveryPreservesQuestionAndInterruptsRunning -v
go test -race ./internal/factory -run TestCancellationKillsProcessGroup -v
go test -race ./internal/factory -run TestChildLeaseSurvivesParentDescriptorAndBlocksRetry -v
go test -race ./internal/factory -run TestPersistenceFailureStopsDispatchAndIsNotValidationError -v
go test ./internal/factory -count=10 -timeout 180s
```

`make schema` regenerates the API contract. CI checks for drift. `make release` cross-compiles Linux amd64/arm64 and macOS arm64 binaries and writes SHA-256 checksums. No live-provider tests run in CI.
