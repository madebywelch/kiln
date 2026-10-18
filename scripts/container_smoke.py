#!/usr/bin/env python3
"""Smoke-test the runtime image over loopback HTTP inside a disposable container.

Respects DOCKER_CONTEXT. Requires Docker and Python on the host. Does not expose
a host port, mount credentials, invoke models, or write to a remote repository.
"""
import argparse
import os
from pathlib import Path
import secrets
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--image", default="kiln:0.1.0")
parser.add_argument("--sandbox", action="store_true", help="Also test native Linux Codex sandboxing")
parser.add_argument("--seccomp", default="/etc/kiln/seccomp.json")
parser.add_argument("--network", action="store_true", help="Also install a pinned toolchain version from the network")
args = parser.parse_args()
security = (["--security-opt=seccomp=" + args.seccomp, "--security-opt=apparmor=kiln-container"]
            if args.sandbox else [])
env = dict(os.environ, KILN_TOKEN=secrets.token_hex(32))
container = subprocess.check_output(
    ["docker", "run", "-d", "--rm", "--init", "--read-only", "--cap-drop=ALL",
     "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp:rw,exec,nosuid,nodev,size=512m,mode=1777",
     *security, "-e", "KILN_TOKEN", args.image],
    env=env, text=True,
).strip()
try:
    for attempt in range(50):
        ready = subprocess.run(
            ["docker", "exec", container, "curl", "--fail", "--silent", "http://127.0.0.1:8741/healthz"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        if ready.returncode == 0:
            break
        time.sleep(0.1)
    else:
        subprocess.run(["docker", "logs", container], check=False)
        raise RuntimeError("container did not become ready")
    subprocess.run(["docker", "exec", container, "mkdir", "-p", "/data/examples"], check=True)
    for source, destination in [("examples/retry.yaml", "/data/examples/retry.yaml"),
                                ("scripts/smoke.py", "/data/smoke.py"),
                                ("scripts/fixtures/toolchain-smoke.sh", "/data/toolchain-smoke.sh"),
                                ("scripts/fixtures/codex-sandbox-smoke.py", "/data/codex-sandbox-smoke.py")]:
        subprocess.run(["docker", "cp", str(Path(source)), container + ":" + destination], check=True)
    subprocess.run(["docker", "exec", container, "python3", "/data/smoke.py"], check=True)
    uid = subprocess.check_output(["docker", "exec", container, "id", "-u"], text=True).strip()
    assert uid == "10001", f"unexpected runtime UID: {uid}"
    for command, expected in [("pi", "1.3.0"), ("codex", "codex-cli 0.162.1")]:
        version = subprocess.check_output(["docker", "exec", container, command, "--version"], text=True).strip()
        assert version == expected, f"{command}: {version}"
    print("Pinned Pi and Codex runtimes verified as non-root.")
    # Match command nodes' minimal environment: PATH plus the inherit_env names
    # from deploy/container.yaml, rather than relying on every Docker ENV.
    inherited = " ".join(f'{name}="${name}"' for name in (
        "MISE_DATA_DIR", "MISE_CACHE_DIR", "CARGO_HOME", "RUSTUP_HOME", "GOMODCACHE", "GOCACHE",
        "COREPACK_HOME", "COREPACK_ENABLE_DOWNLOAD_PROMPT", "npm_config_cache", "PIP_CACHE_DIR"))
    subprocess.run(["docker", "exec", "-e", "KILN_SMOKE_NETWORK=" + ("1" if args.network else "0"), container,
                    "sh", "-eu", "-c", f'exec env -i PATH="$PATH" KILN_SMOKE_NETWORK="$KILN_SMOKE_NETWORK" {inherited} '
                    '/bin/sh /data/toolchain-smoke.sh'], check=True)
    if args.sandbox:
        subprocess.run(["docker", "exec", container, "mkdir", "-p", "/data/sandbox-workspace",
                        "/data/sandbox-home", "/data/sandbox-codex"], check=True)
        # The same sandbox settings KILN passes: private home and shared caches writable.
        subprocess.run(["docker", "exec", "-w", "/data/sandbox-workspace",
                        "-e", "HOME=/data/sandbox-home", "-e", "CODEX_HOME=/data/sandbox-codex",
                        container, "codex", "sandbox", "-c", 'sandbox_mode="workspace-write"',
                        "-c", 'approval_policy="never"',
                        "-c", "sandbox_workspace_write.network_access=true",
                        "-c", 'features.network_proxy={enabled=true,proxy_url="http://127.0.0.1:0",enable_socks5=false,domains={}}',
                        "-c", 'sandbox_workspace_write.writable_roots=["/data/sandbox-home","/data/cache"]',
                        "--", "python3", "/data/codex-sandbox-smoke.py"], check=True)
finally:
    subprocess.run(["docker", "stop", "-t", "20", container], check=False, stdout=subprocess.DEVNULL)
