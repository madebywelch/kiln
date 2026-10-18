# Workflow reference

## Definition

The parser rejects unknown YAML fields, duplicate keys, extra YAML documents, malformed templates, missing edges, unreachable nodes, and cycles without a path to the exit.

| Field | Meaning |
|---|---|
| `version` | Required; currently `1` |
| `name` | Workflow ID: a letter followed by up to 63 letters, digits, `_`, or `-` |
| `description` | Optional description |
| `repository.github` | Optional `owner/repo`; GitHub HTTPS transport authenticated through `gh` |
| `repository.local` | Optional absolute local repository path; requires server permission |
| `repository.base` | Branch or commit to fetch; defaults to remote `HEAD`. Use a branch for PR workflows |
| `sandbox` | Optional remote machine for the whole run: `provider: boat`, `type`, `snapshot`. See [sandbox](#sandbox) |
| `entry`, `exit` | IDs of the unique `start` and `end` nodes |
| `max_steps` | Default 100; maximum 1,000 node visits, including start/end and human gates |
| `inputs` | String-to-string defaults, overridden by run inputs |
| `nodes` | Map of 2-100 node IDs to definitions |

Exactly one repository source may be specified. Without a repository, the run gets an empty private directory.

Each node supports `type`, `next`, `max_visits`, and executable nodes support `timeout`. `max_visits: 0` means bounded only by the run's `max_steps`. Timeouts default to 15 minutes; allowed range is 1 ms to 24 hours. Workspace preparation has a five-minute timeout. Waiting for a human uses no worker and has no deadline; specifying a human timeout is rejected.

## Nodes

### start / end

`start` has exactly one `success` edge. `end` has no edges. Reaching `end` succeeds the run. To reject or fail intentionally, use a command that exits nonzero without a `failure` edge.

### command

```yaml
build:
  type: command
  command: |
    printf '%s\n' "$GOAL"
    make test
  env:
    GOAL: '{{ .inputs.goal }}'
  timeout: 10m
  max_visits: 3
  next: {success: review, failure: repair}
```

Runs `/bin/sh -eu -c` in the run workspace. The shell source is **not templated**. Put untrusted data into quoted environment variables or read the context JSON file. This avoids turning goals or webhook contents into shell code. Standard output and error are combined; the first 64 KiB is retained with a `truncated` flag.

Only `PATH`, `LANG`, and the server's configured `inherit_env` names (image-provided toolchain and cache locations) are inherited from the daemon. `HOME` and `TMPDIR` are always private to the run: a fresh, writable, executable directory under the data directory that is removed with the workspace. Profiles, caches, and downloaded tools from one run never change another run, and `/tmp` restrictions do not apply. Toolchains should come from the image and the repository's own version pins; a command should not bootstrap compilers into `$HOME`. `pass_env: [GH_TOKEN]` explicitly forwards additional host variables, for example when a command itself calls `gh`. `env` sets or templates node-specific values and wins over inherited ones. No secret vault values are copied automatically.

The following variables are supplied:

- `KILN_RUN_ID`: run ID.
- `KILN_WORKSPACE`: absolute working directory.
- `KILN_ARTIFACT_DIR`: private per-run directory outside the repository; put plans, logs, temporary reports, and scratch files here.
- `KILN_BASE_SHA`: pinned original repository base. Compare against this, not `HEAD`, when checking cumulative changes; stages are already committed.
- `KILN_CONTEXT_FILE`: temporary JSON file containing `inputs`, latest `outputs`, `run_id`, `decision`, `candidate`, and `artifacts`. It is outside the worktree, mode 0600, and removed after execution. This avoids OS environment-size limits and accidental commits of inputs. A hard daemon crash may leave these files in the data directory.

```sh
python3 -c 'import json,os; print(json.load(open(os.environ["KILN_CONTEXT_FILE"]))["inputs"]["goal"])'
```

Environment values are limited to 64 KiB each and 128 KiB in total. Large data belongs in the context file. A command timeout routes `failure`, just like a nonzero exit. Canceling a run kills its process group and does not route a failure edge.

### llm

```yaml
plan:
  type: llm
  provider: openrouter
  model: deepseek/deepseek-v3.2
  max_tokens: 2048
  prompt: |
    Plan this task: {{ .inputs.goal }}
  artifact_file: plan.md  # optional; never written to the repository
  next: {success: implement, failure: escalation}
```

Makes a single non-streaming OpenAI-compatible `POST /chat/completions` request. `provider` names a server-configured base URL and credential environment variable. Workflows cannot supply provider URLs or credentials. Any number of providers may be configured independently.

`max_tokens` defaults to 4,096 and is capped at 32,768. The result stores the actual response model, request ID, and reported token usage/cost. Cost is optional and provider-reported, not inferred from a price list. Agent nodes also normalize token usage. Pi catalog cost estimates are deliberately not reported as billed cost.

`artifact_file` is optional and relative to the private run artifact directory. Plans already exist in stored node output; no file is needed unless a later stage needs one. Its complete content is written outside the worktree and downloadable through `GET /v1/runs/{id}/artifacts/{path}`; the inline API output is limited to 64 KiB. `output_file` is no longer accepted. Absolute paths, traversal, and symlink escapes are rejected using Go's rooted filesystem API. Provider bodies are capped at 2 MiB. A token-limit finish, refusal/content filter finish, malformed response, missing credential, HTTP error, or timeout fails the node. Partial token-limited generations do not overwrite files. HTTP redirects are not followed.

There is no hidden provider retry or fallback. Define recovery edges explicitly. This makes repeated charges visible as additional attempts.

### agent

```yaml
implement:
  type: agent
  provider: openrouter
  model: deepseek/deepseek-v3.2
  skills: [dependency-maintenance]
  mcp: [docs]
  prompt: 'Implement {{ .inputs.goal }}. Run tests. Do not publish anything.'
  timeout: 20m
  next: {success: build, failure: escalation}
```

Runs Pi for `provider: openrouter`, or the native subscription-authenticated Codex CLI for `provider: codex`. In a [sandbox](#sandbox) workflow, Pi runs inside the run's remote machine and Codex nodes are rejected. Provider and model are required; there is no runtime selector or argument array. Prompts go through stdin. Pi has fixed `read`, `bash`, `edit`, and `write` tools. Skills/MCP are optional explicit lists on Pi-backed nodes, not global discovery. See [agent resources](AGENT_HARNESS.md).

KILN checks semantic completion as well as process exit; provider errors, truncated responses, or an unfinished answer fail the node. Success means the agent completed—not that code is correct. Run tests afterward. For reviews, request JSON and let a command node interpret `.outputs.reviewer.output`.

Codex uses an isolated per-attempt home/config directory and its existing `auth.json` through a symlink. It runs with a workspace-write sandbox and low reasoning effort; it is not forced past sandbox restrictions. A reviewer prompt is **not** a read-only security policy. Node-scoped skills/MCP are currently Pi-only; Codex nodes reject those fields.

Agent results include harness, actual model, response ID when available, turns, tool-call count, and usage. Attempts expose a transcript URL through the [API](API.md). Raw JSONL remains available after workspace cleanup; interrupted attempts may have partial records.

### human

```yaml
approval:
  type: human
  prompt: 'Build: {{ .outputs.build.output }}. Publish?'
  choices: [approve, revise, reject]
  next: {approve: publish, revise: repair, reject: rejected}
```

Every choice needs an edge. Choices are unique identifiers. The daemon persists a question, sets the run to `waiting`, and releases the worker. The API answer must include the exact question ID and a valid choice. Replayed/stale answers return 409, including when a loop revisits the same node. Comments are limited to 8,192 characters at the API boundary.

When a candidate exists, the question and answer are bound to its `candidate_id`. Supply that ID with the answer to detect stale client state; the server records the binding even if it is omitted. Inspect `.run.candidate` and the candidate diff before approving. Later source changes block publication; a replacement candidate needs a new bound decision if an earlier candidate was reviewed.

The last decision is available as `.decision.choice` and `.decision.comment`. All earlier decisions remain in the attempt and event history. Use `{{ with .decision }}...{{ end }}` before the first decision exists.

### changeset

```yaml
candidate:
  type: changeset
  files: [src/feature.go, src/feature_test.go, go.sum]
  exclude: [scratch-report.txt]  # explicit residue classification, not a glob
  command: go test ./...
  title: 'fix(feature): handle empty input'
  body: |
    Return an empty result instead of panicking when input is empty.

    Validation: go test ./... passes in a fresh candidate checkout.
  next: {success: approval, failure: repair}
```

Requires a repository, a selection, a validation command, a Conventional Commit `title`, and explanatory PR `body`. The title is one line, at most 120 bytes; the body is at most 4,000 bytes. Configure both in YAML or templates; KILN adds no signatures, tool links, execution history, or attribution. Git uses the service account's configured author/committer identity, not a hardcoded bot; an absent explicit identity fails publication preparation.

`files` and `exclude` are exact repository-relative file paths, not directories or globs (maximum 256 combined). Every base-relative added, modified, or deleted path must be classified. Unclassified paths block preparation. An unchanged listed path is harmless. Generated deliverables and lockfiles can be explicitly selected; there is no language-specific blacklist. A rename is its deletion plus addition.

For open-ended work, obtain the selection from a model or command instead of predicting filenames:

```yaml
  selection: '{{ .outputs.select.output }}'
```

The rendered string must be exactly one JSON object such as `{"files":["src/new.go"],"exclude":["scratch.txt"]}`. Unknown/duplicate properties, invalid paths, overlap, and an empty effective changeset fail. `selection` cannot be combined with `files`/`exclude`. Generated paths are data, never rendered as a second template.

KILN constructs **one product commit directly on the pinned base**, using only selected files from the checkpointed source tree. It materializes that commit in a new detached checkout and runs `command` there with the usual environment/timeout rules. No working-tree caches, excluded files, or audit ancestors are copied. Validation must leave tracked files unchanged and no unignored output. Ignored build products generated by the check are disposable and never imported into the already-created commit. Validation worktrees are removed; crashes leave them for explicit workspace cleanup.

A successful result stores the candidate ID, commit/tree/base/source hashes, selected/excluded paths, author/committer, check command, timestamp and PR text. `GET /v1/runs/{id}/candidate/diff` returns only the product diff. A new changeset attempt clears the previous active candidate, even if preparation fails.

### pull_request

```yaml
publish:
  type: pull_request
  draft: true
  next: {success: end}
```

Requires `repository.github` and a previously validated changeset. Title/body belong on the changeset, not this node. The node verifies candidate provenance, unchanged source, any bound human decision, and every effective fetch/push URL of `origin`. It pushes only the candidate commit to `<github-user>/<short-topic>`, for example `octocat/fix-intervals`. The namespace comes from the authenticated GitHub user, not the repository owner or Git commit author. Preparation resolves and pins the branch before approval; retries reuse it even if authentication changes. The topic uses the Conventional Commit type and the whole scope (`fix(intervals)` becomes `fix-intervals`, `chore(deps-2026-10-10)` becomes `chore-deps-2026-10-10`); a topic over 32 bytes is rejected rather than truncated, because truncation would merge distinct scopes into one branch. Without a scope, it uses the type and up to three subject words, bounded to 32 bytes without splitting words. Topics are lowercase and hyphen-separated. Use a concise scope to control the name. No branding, hashes, timestamps, or run-ID suffixes are added. A conflicting branch stops publication rather than generating a suffix. The private `kiln/<run-id>` recovery branch and tags are never pushed. Hooks and automatic signing are disabled.

Branch creation uses an expected-absent Git ref lease, so a racing writer cannot be overwritten. An existing branch must already point to the exact candidate. Repeating publication reuses the matching open PR; changed heads/text, closed/merged PRs and ambiguous matches fail rather than overwriting someone else's edits. Revised work after publication needs a new run with a distinct topic rather than rewriting an existing PR branch.

Only one changeset node and one PR node are allowed per workflow; a bounded loop may revisit them. Human gates are optional, but put one **after changeset validation** when approval is required. Cleanup preserves internal artifacts and private audit/candidate refs. Nothing merges automatically.

## Sandbox

```yaml
sandbox:
  provider: boat
  type: default            # small | default | large | xlarge
  snapshot: kiln-toolchain # optional named snapshot
```

A workflow with a `sandbox` block runs every `command`, `agent`, and `changeset` validation command of a run on one dedicated [boat.dev](https://boat.dev) virtual machine. `llm`, `human`, and `pull_request` nodes, Git checkpoints, candidate construction, approvals, and publication stay on the daemon host. The server must configure the provider under `sandboxes` ([deployment](DEPLOYMENT.md#remote-machines)); registration rejects workflows for an unconfigured provider.

The machine is created during workspace preparation with none of the boat account's secrets (`noEnv`), no provider-side command history (`monitoring: false`), an idempotency key derived from the run ID, and the `KILN_RUN_ID` tag. `type` defaults to the provider default size. `snapshot` names a saved machine image; use one to pin toolchains and the Pi version instead of relying on the provider's base image, which updates its agents to their latest release. The run records the machine as `run.sandbox` (`provider`, `id`, `type`, `home`); every remote attempt result carries `sandbox: <id>`.

Before a node, KILN brings the machine to a running state (resuming a stopped one), extends its auto-stop past the node timeout, and makes the remote checkout equal to the host checkout's HEAD by shipping a Git bundle of the missing objects. Files matching `.gitignore` stay on the machine between nodes, so build caches persist for the run. After the node, the remote working tree returns as a tree bundle and becomes the ordinary attempt checkpoint; `KILN_ARTIFACT_DIR` is mirrored in both directions (deletions are not propagated). Collection also runs for failed and timed-out attempts. Synchronization time counts against the node timeout.

The process runs as the sandbox user in the run's checkout with a minimal environment: the machine's `PATH`, `HOME`, `LANG`, and `LC_ALL`, the node's `env` and `pass_env`, and the `KILN_*` variables with machine-side paths. The provider's own variables are not forwarded. Set `PATH` through `env` if a snapshot installs tools outside the default path. `inherit_env` and `cache_dirs` are daemon-host settings and do not apply.

Agent nodes run Pi from the machine's `PATH` with the same private configuration as on the host; `provider: codex` is rejected because subscription credentials never leave the daemon. The OpenRouter key and any selected MCP credentials reach the machine in the process environment, exactly as on the host; use dedicated, spend-limited keys for sandbox workflows. MCP servers must be `url` servers; stdio servers are daemon-host executables. Skills come from the repository as usual.

A per-run lease inside the machine refuses a new attempt while a previous one is still running there, mirroring the host lease. Node timeouts and cancellation terminate the remote process group through the provider API. Daemon shutdown leaves the machine running for retry; the provider's idle auto-stop bounds that cost. When the run reaches a terminal state, KILN stops the machine (`sandbox.stopped`); `DELETE /v1/runs/{id}/workspace` deletes it. A stopped machine's disk is kept by the provider for 14 days; a retry after that fails with the provider's `snapshot_data_expired` error.

## Templates

Templates use Go `text/template`, with strict missing-key handling and JSON-style lowercase field names:

- `{{ .inputs.goal }}`
- `{{ .outputs.build.output }}`
- `{{ .outputs.build.error }}`
- `{{ .run.id }}`, `{{ .run.branch }}`, `{{ .run.base_sha }}`
- `{{ with index .outputs "reviewer" }}{{ .output }}{{ end }}` for an optional earlier result.

Templates apply to prompts, node environment values, artifact paths, file selections, commit/PR titles, and PR bodies. They do not apply to shell source, repository configuration, edge targets, or model/provider names. There is no general expression interpreter. Use command success/failure or human choices for branching.

## Execution limits and retry semantics

Budgets count every visit, including explicit retries. Retrying a failed or interrupted run does not reset its counters. If a budget is exhausted, register a corrected workflow and submit a new run. A failure edge can recover an ordinary node failure, but budget exhaustion terminates the run immediately.

Every completed repository-stage attempt creates a Git checkpoint, including failed attempts, answered gates, start/end, and unchanged trees. `checkpoint_sha` links each attempt to its commit. These are private audit snapshots, not certification or publishable history. Checkpoints capture non-ignored workspace changes for recovery, but no checkpoint commit is pushed. Keep scratch output in `KILN_ARTIFACT_DIR`; `.gitignore` is not the publication policy. A checkpoint failure interrupts the run; retry reconciles the checkpoint without repeating the already-recorded operation. Unknown interrupted side effects require explicit retry, then receive a checkpoint before a new attempt.

Workspaces remain after completion for inspection. Delete them explicitly with `DELETE /v1/runs/{id}/workspace`. This preserves run history and remote branches, deletes the run's remote machine if it has one, and disables retry. Local repository caches and branch/base references are retained.
