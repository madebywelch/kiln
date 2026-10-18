# Agent harness

KILN owns graph execution, Git worktrees, checkpoints, human decisions and recovery, its plugin marketplace is disabled (it otherwise downloads 30-130 MiB into every attempt directory), and startup update checks are off because the image pins the CLI. Pi owns the coding loop for OpenRouter. Codex owns its subscription-backed loop. The daemon remains a Go binary; agent runtimes are separate processes, included in the Docker image.

Pi Durable is not used: it is experimental, and conversation durability would not make shell commands or remote tool calls exactly-once. KILN journals stage results and retains agent transcripts; interrupted tool loops are never silently resumed.

## Opinionated defaults

- `provider: openrouter` → Pi 1.3.0; `provider: codex` → Codex 0.162.1.
- Provider/model are required. No runtime selector, arbitrary agent arguments, fallback matrix or history toggle.
- Pi tools: `read`, `bash`, `edit`, `write`, plus explicitly selected MCP tools.
- Pi gets repository-root `AGENTS.md`; nested instructions remain discoverable through its file tools.
- Each attempt has its own home/config/session directory, outside the worktree.
- No automatic personal skills, extensions, prompt templates, project `.pi` configuration, or MCP servers. Pi's MCP client is the only enabled built-in extension when MCP is requested.
- Pi uses a conservative 32K context window, 8K maximum output per model response, thinking off, and no automatic transport retries. KILN bounds its observed assistant messages to 100 and raw transcript to 32 MiB. Node timeouts bound both backends.
- Plans, scratch files, logs and temporary reports belong in `KILN_ARTIFACT_DIR`, not the repository. Agent instructions request this; changeset classification and separate publication ancestry enforce the publication boundary even if an agent leaves residue.
- Git checkpoints are private and always enabled for repository runs. Agents are instructed not to commit or publish; the graph owns those operations.
- In a [sandbox](WORKFLOWS.md#sandbox) workflow, Pi runs inside the run's boat.dev machine from that machine's `PATH`, with the same private per-attempt configuration written there. Codex nodes stay on the daemon host and are rejected in such workflows.

## Select resources per node

```yaml
implement:
  type: agent
  provider: openrouter
  model: deepseek/deepseek-v3.2
  skills: [dependency-maintenance]
  mcp: [docs]
  prompt: Update dependencies, consult current documentation, and run the tests.
  next: {success: test}
```

Omitting `skills` or `mcp` selects none. These fields are supported on Pi-backed nodes; Codex nodes reject them rather than pretending to scope native resources. Codex does not inherit personal configuration, repository `.agents/skills` entries are disabled for its review sessions.

Skills live at `.agents/skills/<name>/SKILL.md` in the repository. Frontmatter must have the matching `name` and a nonempty `description`:

```markdown
---
name: dependency-maintenance
description: Update dependencies without changing public behavior.
---

Inspect the manifest and lockfile. Prefer compatible releases.
Run the project's tests and report any unresolved failures.
```

Pi receives only the selected skill descriptions/paths and reads full instructions as needed. Relative scripts and references remain beside the skill. Missing/malformed named skills and symlink escapes fail before inference.

## Server-side MCP registry

Add definitions to the daemon's `server.yaml`:

```yaml
mcp_servers:
  docs:
    url: https://docs.example.com/mcp
    headers:
      Authorization: Bearer ${DOCS_TOKEN}
  project_tools:
    command: /opt/project-tools/bin/mcp
    args: [serve]
    env:
      API_KEY: ${PROJECT_TOOLS_KEY}
```

A workflow references only names. Unknown names are rejected when registering the workflow. Only selected entries and their referenced environment variables reach the attempt; resolved secrets are not written into generated configuration. Ordinary Pi shell commands unset transport credential variables to reduce accidental `env`/debug logging. This is not a credential sandbox: the account can still read its own process/filesystem state, and tools may return secrets. Transcripts remain private.

Supported transports are stdio and streamable HTTP; sandbox workflows accept HTTP servers only, because a stdio server is a daemon-host executable. `command` is an executable, not shell source. Credential interpolation uses `${ENV_NAME}` in `env` and `headers`; command interpolation and interactive OAuth are intentionally unsupported. Servers are checked before inference, and their tools are exposed directly. Remote services must authorize operations themselves; use narrowly scoped tokens.

Changing the registry requires restarting the daemon. Pinned workflows retain resource names, not a snapshot of external server implementations or credentials.

## Results and recovery

The final agent answer becomes `.outputs.<node>.output`. Harness/model, response ID, turn/tool counts and normalized token usage are recorded separately. Pi's catalog-based cost estimate is not billed usage and is not reported as cost. Raw events preserve individual model responses, tool requests/results and usage.

Download an attempt's JSONL:

```text
GET /v1/runs/{run_id}/attempts/{attempt_id}/transcript
```

It is authenticated and remains available after workspace cleanup. During execution or after a crash, the last record can be partial. Agent directories also retain native Pi sessions and up to 64 KiB of stderr for diagnostics. An attempt that failed before launching the harness may have no transcript yet.

A completed answer is not proof of correctness: follow agents with deterministic tests and explicit review gates. Likewise, a Git checkpoint records what happened, including failure—it does not certify the code.

On Linux, Codex's direct restricted-network filter can deny Unix-socket shutdown used by Node's piped subprocesses ([upstream issue](https://github.com/openai/codex/issues/41175)). KILN instead selects managed-proxy mode with an empty domain allowlist and approvals disabled. The proxy network namespace still blocks direct egress, and workspace-write filesystem restrictions remain in place. This permits local Node/Git IPC without granting Internet access. The sandbox may write to the worktree, `TMPDIR`, the run's private `HOME`, `KILN_ARTIFACT_DIR`, and the server's configured `cache_dirs` (shared toolchain caches); the rest of the daemon state stays read-only.

**Resource selection is context hygiene, not isolation.** Pi's `bash` can run commands with the service account's permissions. Codex uses its workspace-write sandbox, but reviewer prompts do not enforce read-only access. A trusted agent can read other accessible files or contact services through shell commands. Use a dedicated host/container, or a sandbox workflow that gives each run its own machine; neither makes KILN a multi-tenant or hostile-code platform, since the run still holds its own credentials.
