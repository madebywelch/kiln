# Hardened reference deployment

This directory is an optional reference for running KILN in a dedicated virtual
machine behind Tailscale Funnel. It is an example of a narrow trust boundary,
not a turnkey installer. Replace every `<placeholder>` and adapt the paths,
addresses, and limits to your environment.

The design assumes a single operator and a single host. See
[Deployment and operations](../../docs/DEPLOYMENT.md) for the general model.

## Layout

- Dedicated Ubuntu 24.04 VM with 4 vCPUs, 4 GiB RAM, and at least 24 GiB disk.
- Private libvirt network `<kiln-network>`, bridge `<bridge>`, guest `<guest-ip>`.
- Container runs as UID 10001 with a read-only root, no added capabilities, no
  Docker socket, and no personal home mounts.
- Limits: 2 GiB container memory, 3 CPUs, 256 processes, two workflow workers.
- `/opt/kiln/compose.yaml` and `.env`: service definition and deployed image ID.
- `/etc/kiln/server.yaml`: daemon configuration.
- `/etc/kiln/credentials.env`: root-only runtime credentials (mode 0600).
- `/var/lib/kiln`: persistent data; SQLite, worktrees, and artifacts under
  `state/`, Codex credentials under `codex/`.
- Host firewall rules block workload access to the host and private networks.
- Tailscale runs with `--tun=userspace-networking`: there is no `tailscale0`
  interface, kernel tailnet route, SOCKS proxy, or exposure of native VM
  services. Funnel proxies only to loopback. Guest firewall rules fail closed if
  kernel TUN mode is accidentally restored.
- KILN binds only to guest loopback through Docker's published port
  `127.0.0.1:8741`.
- `kiln.service`, `kiln-funnel.service`, Docker, Tailscale, and the VM/network
  are configured to start automatically.

This is a pilot topology. It has no automatic retention policy or off-host
backup. Rust/Tauri builds can consume several GiB per worktree; keep headroom
for Cargo output and image upgrades, and clean completed workspaces through the
API.

## Access and authentication

Expose the API through a hostname such as
`https://<tailnet-host>.<tailnet>.ts.net`. Do not assume `tailscale funnel
status` alone proves public availability: verify `/healthz` from outside the
tailnet and confirm that `/v1/status` returns 401 without a bearer token and 200
with one. Repeat those checks after any networking change.

All API, schema, and documentation requests require
`Authorization: Bearer <token>`. `/healthz` is public liveness. GitHub webhooks
require their separate HMAC signature.

Store credentials in your secret manager and install a protected local
credential file on the host. The service must not depend on a live secret-manager
login. Required values:

- `KILN_TOKEN`
- `KILN_GITHUB_WEBHOOK_SECRET`
- `OPENROUTER_API_KEY` (if using OpenRouter-backed nodes)
- `GH_TOKEN` (if using repository workflows)
- `CODEX_AUTH_JSON` (if using Codex-backed nodes)

```sh
export KILN_URL=https://<tailnet-host>.<tailnet>.ts.net
export KILN_TOKEN='<token>'
curl --fail-with-body "$KILN_URL/v1/status" \
  -H "Authorization: Bearer $KILN_TOKEN"
```

Never commit credentials or include tokens in URLs.

## Operations

From the repository root:

```sh
ssh -F deploy/hardened/ssh_config kiln-guest
```

Inside the guest:

```sh
sudo systemctl status kiln.service kiln-funnel.service
sudo docker logs --tail 100 kiln
sudo tailscale status
sudo tailscale funnel status
sudo systemctl restart kiln.service
```

To withdraw public access without deleting data:

```sh
sudo systemctl disable --now kiln-funnel.service
sudo tailscale funnel --https=443 off
```

The runtime includes C/C++ compilers, Linux/Tauri development libraries, and
mise-managed defaults (Node, pnpm, and Go) as read-only system installs. A
repository's own version pins are installed on first use into
`/var/lib/kiln/cache`, which also holds the Cargo, Go, npm, pnpm, and pip caches
shared by all runs. Each run gets a private `HOME` and `TMPDIR` under
`/var/lib/kiln/state/scratch/<run>`, removed with its workspace. Changing the
default versions or operating-system libraries requires an image rebuild;
`/etc/mise/config.toml` inside the image is the single place that defines them.

## Codex sandbox prerequisites

The stock Docker namespace restrictions prevent the pinned Codex runtime's
bubblewrap sandbox from starting. This deployment keeps `cap_drop: [ALL]` and
`no-new-privileges` and grants no `SYS_ADMIN` capability or privileged container
mode.

- `prepare-seccomp.py` derives a profile from a pinned, checksum-verified
  [Moby default profile](https://github.com/moby/profiles). Only `clone`,
  `clone3`, `unshare`, `setns`, `mount`, `umount2`, and `pivot_root` are
  exempted from its capability-dependent namespace restrictions. Kernel
  capability checks still apply. Install the upstream license beside the
  generated profile.
- `apparmor.profile` permits nested user namespaces without Ubuntu transitioning
  them into its restrictive `unprivileged_userns` profile. It is an unconfined
  container profile, not an additional filesystem boundary. The dedicated VM,
  container mount namespace, non-root UID, read-only root, dropped capabilities,
  and Codex's inner sandbox provide the boundaries.
- Verify with a no-inference sandbox probe that Codex can write in its workspace
  but not another writable directory outside it.

Install these profiles before starting Compose; AppArmor loads the guest profile
at boot. Do not deploy this profile onto a shared Docker host without reviewing
that trust boundary.

## Updating and recovery

Build the image in the guest from an explicit source archive containing
`examples/`, `testdata/`, `scripts/`, the Go source, and the harness lockfile. Do
not upload `.git`, `.kiln`, credentials, or local agent homes. Confirm the clean
Linux build passes formatting, vet, and race tests before producing the runtime
image.

Record the new image ID in `/opt/kiln/.env`, then run:

```sh
sudo docker compose -f /opt/kiln/compose.yaml --env-file /opt/kiln/.env up -d --wait
```

Keep a matching binary/image and data backup together. Database schema versions
are not migrated automatically.

On a disk-constrained guest, build to a compressed archive instead of the image
store, prune, then load:

```sh
sudo docker build --target test -t kiln-test .
sudo docker build --output type=docker,dest=/home/ubuntu/kiln.tar,compression=gzip,name=kiln:<version> --build-arg VERSION=<version> .
sudo docker builder prune -af && sudo docker image rm kiln-test
sudo docker load -i /home/ubuntu/kiln.tar && rm /home/ubuntu/kiln.tar
```

Verify with `sudo python3 scripts/container_smoke.py --sandbox --network
--seccomp /etc/kiln/seccomp.json --image kiln:<version>` before switching the
service. After switching, register a no-repository command workflow that prints
the tool versions, `$HOME`, and `$TMPDIR`, plus a repository workflow with one
Codex and one Pi node, then delete their workspaces.

Before backing up, stop KILN and copy `/var/lib/kiln` in full. SQLite alone is
insufficient. Keep credentials and Tailscale state in encrypted backups. Restore
data to the same absolute path.
