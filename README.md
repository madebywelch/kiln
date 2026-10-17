# KILN

[![ci](https://github.com/madebywelch/kiln/actions/workflows/ci.yaml/badge.svg)](https://github.com/madebywelch/kiln/actions/workflows/ci.yaml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

An API-first software factory. Define a graph in YAML. Run commands, call models, route failures through repair loops, pause for human decisions, and publish a pull request from an isolated Git worktree.

One Go binary. SQLite state. No external queue or database. Linux and macOS.

KILN is pre-1.0. The workflow schema and HTTP API may change between minor releases; pinned runs and database state are versioned and are not migrated across incompatible schemas.

## Start locally

Requires Go 1.26+ to build. Git is required for repository workflows. `gh` is required for GitHub authentication and PRs. Pi 1.2.0 (Node 22.19+) and Codex 0.162.1 are the opinionated agent backends; native installations need their own project toolchains. The Docker image includes both agents, C/C++ build tools, Linux/Tauri development libraries, and mise-managed Node, pnpm, Go, and Rust defaults; a repository's own version pins are installed on first use. For a native installation, run `npm ci --prefix harness` and add `harness/node_modules/.bin` to the daemon's `PATH`.

```sh
make check
export KILN_TOKEN="$(openssl rand -hex 32)"
./bin/kiln serve -config examples/server.yaml
```

In another terminal with the same token, use the API to register a workflow and submit a run. The [API guide](docs/API.md) covers authentication, the request sequence, and the endpoint inventory; [OpenAPI 3.1](docs/openapi.json) defines every payload.

For disposable loopback-only development, `kiln serve -insecure-local` explicitly disables authentication when no token is set. Never expose that listener through a tunnel or reverse proxy.

## The primitives

| Primitive | Meaning |
|---|---|
| Workflow | Versioned YAML graph with exactly one start and end |
| Node | A command, model call, coding agent, changeset validation, human gate, or PR operation |
| Edge | A named outcome mapped to the next node |
| Run | A pinned workflow snapshot, inputs, workspace, cursor, outputs, and attempt history |
| Attempt | One execution of a node; loops create additional attempts |
| Question | A persisted human gate with a unique ID and explicit choices |
| Event | A durable state transition, replayable over REST or SSE |
| Automation | A pinned workflow plus a cron schedule or exact event name |

```yaml
version: 1
name: build-repair
entry: start
exit: end
max_steps: 20
nodes:
  start:
    type: start
    next: {success: build}
  build:
    type: command
    command: test -f fixed
    max_visits: 3
    next: {success: end, failure: repair}
  repair:
    type: command
    command: touch fixed
    next: {success: build}
  end:
    type: end
```

`failure` without an outgoing edge fails the run. Reaching `end` succeeds it. Every declared node must be reachable from the entry and have a structural path to the exit. Cycles are valid; execution budgets bound them.

## Models and GitHub

`examples/multi-provider.yaml` is a 12-node acceptance workflow:

```text
start → DeepSeek plan → build ──failure──→ DeepSeek repair ──→ build
                         │
                      success
                         ↓
                  Codex review → verdict ──failure──→ repair
                         │          │
                      failure    success
                         ↓          ↓
                   retry/stop    clean changeset validation
                                    ↓
                                 human approval ──revise──→ repair
                                    │
                                 approve
                                    ↓
                               draft PR → end
```

It uses `deepseek/deepseek-v3.2` through OpenRouter and the locally authenticated Codex CLI as an independent reviewer. Each agent node selects its provider and model; KILN chooses Pi for OpenRouter and Codex for the subscription. The model must be available to the authenticated account, and an unavailable model fails the node rather than silently switching providers.

```sh
export OPENROUTER_API_KEY=...  # inject from your secret manager
# Authenticate on the machine running kiln, under its service account.
gh auth login --hostname github.com
codex login
```

Set `repository.github: owner/repo` in the workflow. KILN creates a unique `kiln/<run-id>` branch and worktree. Every completed stage attempt gets a Git audit commit, including failures and unchanged trees—there is no history toggle. Checkpoints remain private and survive workspace cleanup. A `changeset` node explicitly selects files, rejects unclassified residue, and tests a clean candidate checkout. It creates one Conventional Commit directly on the pinned base using the configured Git identity. Human approval binds that candidate. A `pull_request` node publishes only this product commit to `<github-user>/<short-topic>` (for example, `octocat/fix-intervals`) on the verified GitHub `origin`; audit ancestry and tags are not pushed. Nothing merges automatically.

Pi-backed nodes may name `skills: [dependency-maintenance]` and `mcp: [docs]`. Skills resolve from `.agents/skills/<name>/SKILL.md` in the repository; MCP names resolve against the daemon's registry. No personal/global resources are inherited. See [agent resources](docs/AGENT_HARNESS.md).

Local repository fixtures require the server's explicit `allow_local_repositories: true` policy. Gitea is not used.

Internal plans and reports stay outside the repository in `KILN_ARTIFACT_DIR`. File selection, validation commands, Conventional Commit subjects, and concise PR bodies are workflow configuration—not language-specific exclusion lists. See [changesets](docs/WORKFLOWS.md#changeset).

## Automations

An automation pins a workflow revision plus exactly one trigger: a five-field UTC cron schedule or an exact event name. Save it through `PUT /v1/automations/{id}`, dispatch application events through `POST /v1/events`, and fire it manually through `POST /v1/automations/{id}/fire`. The [API guide](docs/API.md#automations) has the request shapes.

GitHub webhooks use `/v1/webhooks/github`, HMAC-SHA256 signatures, and delivery-ID deduplication. Configure `KILN_GITHUB_WEBHOOK_SECRET`. An automation such as `event: github.issues.opened` must also specify `github_repository: owner/repo`. Repository and event names must match; a webhook cannot supply a workflow or command.

Only one active run per automation is allowed. Waiting and interrupted runs count as active. Overlapping event deliveries are skipped and reported; manual fires return 409. Missed cron ticks coalesce into one run on restart. There is no backlog replay.

## API and documentation

- [API guide](docs/API.md): quick start, request examples, chat-client integration, and endpoint inventory.
- [Workflow reference](docs/WORKFLOWS.md): node fields, templates, environment, and limits.
- [Agent harness](docs/AGENT_HARNESS.md): fixed tools, per-node skills/MCP, transcripts, and credentials.
- [Architecture](docs/ARCHITECTURE.md): state machine, durability, and deliberate scope.
- [Deployment](docs/DEPLOYMENT.md): binaries, Docker, systemd, security, and backups.
- [Testing](docs/TESTING.md): deterministic tests and billable live acceptance.
- [OpenAPI 3.1](docs/openapi.json): generated from the actual HTTP handlers. `kiln openapi` exports it; the daemon serves `/openapi.json` and `/docs` behind authentication.

## Verification

```sh
make check          # format, vet, race tests, build, example validation
make docker-test    # clean Linux build and race tests
make release        # static Linux amd64/arm64 and macOS arm64 binaries
make schema         # refresh the committed API contract
```

The opt-in live acceptance test publishes a draft PR to a disposable private repository. It verifies one Conventional Commit, the configured Git identity, exact selected files, no checkpoint ancestry, and concise PR text. It also exercises real inference, failing builds, repair, independent review, restart at a human gate, cron, signed webhooks, deduplication, and rejection. A separate local acceptance exercises a named skill and MCP tool with real inference. See [testing](docs/TESTING.md) for prerequisites and commands.

## Scope and trust

This is a single-host, single-operator engine. Graph execution is sequential within a run; independent runs execute concurrently. Parallel fan-out/join, distributed workers, multi-tenant authorization, and per-node containers are not implemented.

**A worktree is not a security sandbox.** Workflow authors and API token holders can execute arbitrary code as the service account. Run on a dedicated machine or container with narrowly scoped credentials. Commands have a minimal environment, but they can still read files available to that account.

Database schema version 3 is checked at startup. Earlier pre-release databases are intentionally not migrated; preserve them separately and register workflows in fresh `.kiln` state.

External side effects are not exactly-once. A crash during a command, model request, or GitHub operation leaves an `interrupted` run. Inspect the workspace and last attempt before explicitly retrying. See the deployment guide before exposing the API remotely.

## Contributing and license

Development is issue-first. Open an issue with a reproducible problem or a concrete, scoped proposal; the maintainers implement accepted changes. Unsolicited pull requests are closed. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full policy. Report security issues privately as described in [SECURITY.md](SECURITY.md). This project is released under the [MIT License](LICENSE).
