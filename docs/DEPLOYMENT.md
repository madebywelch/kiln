# Deployment and operations

## Native binary

```sh
make release VERSION=0.1.0
# bin/kiln-linux-amd64
# bin/kiln-linux-arm64
# bin/kiln-darwin-arm64
# bin/SHA256SUMS
```

Linux builds are statically linked with CGO disabled, including the SQLite implementation. Install the binary on the target machine and verify its checksum. Install Git and `gh` for repository/PR workflows, plus whatever compilers, runtimes, and agent CLIs your workflows invoke.

The example `deploy/kiln.service` runs as a dedicated `kiln` Unix account. Create that account with `/var/lib/kiln` as its home, install the unit, and provide:

- `/etc/kiln/server.yaml`: start from `examples/server.yaml`, with `data_dir: /var/lib/kiln/state`.
- `/etc/kiln/credentials.env`: mode 0600, owned by root; inject `KILN_TOKEN`, provider credentials, `BOAT_API_KEY` for sandbox workflows, and the optional webhook secret from your secret manager.
- Service-account Git identity and GitHub authentication. `GH_TOKEN` can be injected, or authenticate `gh` under that account. Never copy your entire personal home directory to the server.
- Node 22.19+ and pinned agent runtimes: `npm ci --prefix harness`; add its `node_modules/.bin` directory to the service `PATH`. Codex subscription nodes also need `codex login` under the service account. Authentication stays with the CLI; no subscription-to-API token exchange.

```sh
sudo install -m 0755 bin/kiln-linux-amd64 /usr/local/bin/kiln
sudo install -m 0644 deploy/kiln.service /etc/systemd/system/kiln.service
sudo systemctl daemon-reload
sudo systemctl enable --now kiln
sudo journalctl -u kiln -f
```

The service unit uses process-group/cgroup termination, a private temporary directory, a restricted writable state directory, and no privilege escalation. Adjust the unit deliberately if a workflow needs additional filesystem access. The daemon does not grant that access itself.

Publication uses standard Git `user.name`/`user.email` or explicit `GIT_AUTHOR_*` and `GIT_COMMITTER_*` environment configuration. KILN supplies no bot identity or attribution and rejects guessed identities when creating product commits. Verify the recorded candidate author/committer before approving. Public branch names use the user returned by `gh api user --hostname github.com --jq .login`, independently of commit identity. GitHub candidate preparation requires that authenticated lookup to succeed; it never falls back to a repository owner or a branded namespace. Commit subjects and PR text are configured on the workflow's `changeset` node.

## Docker

```sh
export KILN_TOKEN="$(openssl rand -hex 32)"
# Optionally inject OPENROUTER_API_KEY, BOAT_API_KEY, GH_TOKEN, and Git identity.
export GIT_AUTHOR_NAME='Your name'
export GIT_AUTHOR_EMAIL='you@example.com'
# Optional distinct committer; otherwise Compose uses the author.
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
docker compose up --build -d
```

The container runs as UID 10001, listens inside the container on port 8741, and publishes only on host loopback. State lives in a named volume. The image includes Git, `gh`, Python 3, C/C++ build tools, `pkg-config`, Linux/Tauri development libraries, CA certificates, the pinned Pi 1.2.0 and Codex 0.162.1 runtimes on their own Node, and the daemon. Agent dependencies are locked in `harness/package-lock.json`.

Project toolchains are managed by [mise](https://mise.jdx.dev) from `/etc/mise/config.toml`. The image pre-installs Node 24.21.0, pnpm 10.33.0, Go 1.27.2, and Rust 1.99.0 (Cargo, rustfmt, Clippy) as image-owned, read-only system installs. A repository that pins a different version through its own files (`.node-version`, `.nvmrc`, `package.json` `packageManager`, `go.mod` `toolchain`, `rust-toolchain.toml`, `.python-version`, `.tool-versions`, `mise.toml`) gets that version installed on first use into the shared cache volume; no image rebuild or per-workflow bootstrap script is needed. Go's own `GOTOOLCHAIN=auto` also honors newer `go.mod` requirements. Tool versions therefore follow the repository, not the host. Operating system libraries still come from the image; add them in a derived image.

Shared caches live under `/data/cache` (`MISE_DATA_DIR`, `CARGO_HOME`, `RUSTUP_HOME`, `GOMODCACHE`, `GOCACHE`, `COREPACK_HOME`, the npm cache, and pip). pnpm's content store stays in the run's private home. The daemon forwards those locations through `inherit_env` in `deploy/container.yaml` and declares `/data/cache` in `cache_dirs` so that builds inside the Codex sandbox may write to it. Every run gets its own `HOME` and `TMPDIR` under `/data/state/scratch/<run>`; nothing is shared through a home directory. `/tmp` is an executable tmpfs. Login shells (`bash -lc`, used by Codex) see the same tools through `/etc/profile.d/kiln-toolchains.sh`. For Codex, provision a dedicated writable credential directory at `/data/codex` and set daemon environment `CODEX_HOME=/data/codex`; authenticate there under UID 10001. Do not bake credentials into the image. Do not mount the Docker socket or your personal home directory.

The Docker test stage uses a clean Go 1.27.2 Linux environment:

```sh
docker build --target test -t kiln-test .
```

On a machine with several Docker engines, select the engine per command with `docker --context NAME ...`. No global Docker context change is required.

The optional [hardened reference deployment](../deploy/hardened/README.md) shows a dedicated-VM topology with a read-only container, dropped capabilities, an executable `/tmp`, a signed Tailscale Funnel, and the seccomp/AppArmor profiles needed by the Codex sandbox. Treat it as a starting point, not a supported installer.

## Network and credentials

- Default listener: `127.0.0.1:8741`.
- A bearer token of at least 32 characters is mandatory unless `-insecure-local` is explicitly set on a loopback listener.
- Terminate TLS at a trusted reverse proxy, or use an SSH/tailnet tunnel. Do not send bearer tokens over a public HTTP connection.
- Keep `/v1/webhooks/github` behind HTTPS. Its HMAC secret must be separate from the API token.
- Disable buffering for SSE at the proxy and allow long-lived responses. Authenticate the request once; reconnects must send the bearer header again.
- Provider URLs are server configuration, not workflow input. Use HTTPS for hosted inference.
- Changing credentials, providers, or server policy requires a daemon restart.

Workflows and captured outputs can contain private source code. Tokens are not automatically redacted from process output. Commands get a minimal environment, but trusted code can still read files and credentials available to the service account. Use narrowly scoped GitHub/provider credentials and a dedicated host or container. Do not give untrusted users this API.

## Remote machines

Workflows with a `sandbox` block need a provider entry:

```yaml
sandboxes:
  boat:
    url: https://boat.dev/api/v1   # default
    key_env: BOAT_API_KEY           # default
    idle_timeout: 1h                # provider auto-stop between nodes; 1m-720h
```

Create the key with boat's `ci` preset (create, use, stop, resume, and delete the machines this key created) and inject it like other credentials. The daemon creates machines without the boat account's secrets and with command history disabled; the only credentials a machine receives are the node's `pass_env` values, the OpenRouter key for Pi agents, and selected MCP credentials. Use dedicated, spend-limited keys for those.

Cost follows the run: the machine is billed from creation until the run reaches a terminal state, plus idle periods at human gates and after interruptions until `idle_timeout` archives it. Stopped machines are not billed; their disks are kept 14 days by the provider. `DELETE /v1/runs/{id}/workspace` deletes the machine. Trial accounts cap auto-stop at two hours: `idle_timeout` plus the node timeout plus a ten-minute margin must stay below that, or the node fails before it starts with the provider's `trial_auto_stop_required` error. Accounts without an active plan fail preparation with `billing_required`.

The provider's base image carries its own toolchains and the latest Pi release. Save a named snapshot with your pinned versions and reference it as `sandbox.snapshot`; tools installed outside the default `PATH` need a `PATH` entry in the node's `env`.

## Shutdown and recovery

SIGTERM/SIGINT stops HTTP acceptance and execution. Active process groups are killed, active operations become `interrupted`, queued runs remain queued, and waiting questions remain waiting. Startup never automatically replays an ambiguous external operation.

SIGKILL or a power failure cannot perform cleanup. A native daemon hard-killed without a service manager may leave child processes alive. Subprocesses inherit a per-run execution lease; retry, dispatch, and cleanup refuse to proceed while a surviving child retains that lease. Agent runtimes may close inherited descriptors in their own child processes, and programs can deliberately close them; process groups alone do not prevent orphaning. Use systemd's cgroup cleanup or container lifecycle management, inspect/stop orphaned processes, then retry deliberately. A malicious process can also detach from its group; this is not a hostile-code sandbox.

Inspect `/v1/status` and the run's attempts/workspace. If a lease is held, `lsof /var/lib/kiln/state/leases/RUN_ID.lock` identifies surviving holders. Do not delete lock files to bypass a lease: that can allow concurrent writes to the same worktree. Correct the dependency, surviving-process, or storage problem first. Then:

```sh
curl --fail-with-body -sS "$KILN_URL/v1/runs/RUN_ID/retry" \
  -H "Authorization: Bearer $KILN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"acknowledge_side_effects":true}'
```

Retries preserve budgets and earlier attempts. Unknown interrupted operations may repeat a charge or mutation. An already-journaled result with a pending Git checkpoint instead reconciles the checkpoint without repeating the operation. A PR retry verifies the origin and reuses the run branch/PR where possible. Do not retry blindly after a remote timeout.

A canceled run cannot be resumed. Submit a new run if cancellation was a mistake. An interrupted automation run blocks further firings until it is retried to completion or canceled.

## Storage and retention

The data directory contains private per-run artifacts, candidate validation worktrees (removed after validation; retained after a crash until cleanup), SQLite state/WAL files, the daemon lock, per-run execution leases, bare repository caches, worktrees, per-attempt agent directories (JSONL, session data, bounded stderr, isolated configuration), and transient command context files and Git bundles exchanged with remote machines. It must be on a local filesystem, writable only by the service account. The daemon's umask is 0077.

For a consistent full backup:

1. Stop the service gracefully.
2. Back up the entire data directory, not just `state.db`.
3. Restart the service.

An online SQLite backup alone protects run metadata but does not synchronize worktree files. Copying a live database file without its WAL is not a valid backup procedure. Restore into the same absolute data path because persisted runs and Git worktree metadata contain absolute paths. A different-path migration requires repairing those paths before resuming work.

There is no automatic state/event/dedup retention policy yet. Monitor disk usage. Delete terminal workspaces through the API when no longer needed; history and remote branches remain, and a run's remote machine is deleted. Repository caches and local branch/base references also remain for recovery/audit. Remove remote test branches or close PRs only as a separate, explicit operation.

Database schema version 3 is checked at startup. Earlier pre-release state is intentionally not migrated; preserve it separately and register workflows in fresh `.kiln` state. Unknown versions refuse to start. Take a backup before upgrading; restore the matching data and binary together for rollback.

## Health and logs

`GET /healthz` is public liveness only. Authenticated `/v1/status` includes the healthy flag, worker capacity, active operation count, and counts by run status. A persistence fault stops dispatch and marks the engine unhealthy; inspect structured stderr logs and fix storage before restarting.

Every run transition has a durable event. Use cursor-based SSE or REST replay to diagnose the last committed action. Models record response IDs and provider-reported usage/cost. Command output and agent final answers are bounded to 64 KiB. Raw agent JSONL is retained up to 32 MiB per attempt and available through the transcript API while running or after interruption. Pi stops after at most 100 observed assistant messages; both backends have the node timeout. No aggregate cost/disk quota is implied.
