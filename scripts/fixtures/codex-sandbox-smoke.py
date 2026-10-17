#!/usr/bin/env python3
"""Run inside the real Codex workspace-write sandbox. No inference or credentials."""
import json
import os
from pathlib import Path
import socket
import subprocess
import urllib.error
import urllib.request

# A cold, isolated HOME resolves the repository's pin from the image offline.
Path("package.json").write_text(json.dumps({"name": "kiln-sandbox-smoke", "private": True,
                                           "packageManager": "pnpm@10.33.0"}))
assert subprocess.check_output(["pnpm", "--version"], text=True).strip() == "10.33.0"
assert subprocess.check_output(["node", "--version"], text=True).strip() == "v24.21.0"

# Reproduce Guaca's execFileSync/git fixture and the exact upstream stdio bug.
subprocess.run(["node", "-e", r'''
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kiln-git-"));
try {
  const result = cp.spawnSync("git", ["--version"], {encoding: "utf8"});
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  const git = (...args) => cp.execFileSync("git", args, {cwd: dir, encoding: "utf8"}).trim();
  git("init", "--quiet");
  fs.writeFileSync(path.join(dir, "tracked.txt"), "one\n");
  git("add", "tracked.txt");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "--quiet", "-m", "test: fixture");
  assert.match(git("rev-parse", "HEAD"), /^[a-f0-9]{40}$/);
  assert.equal(git("status", "--porcelain"), "");
} finally {
  fs.rmSync(dir, {recursive: true, force: true});
}
'''], check=True)

# A build inside the sandbox writes to the shared cache and the private home.
Path("go.mod").write_text("module hello\n\ngo 1.22\n")
Path("main.go").write_text('package main\n\nimport "fmt"\n\nfunc main() { fmt.Println(42) }\n')
assert subprocess.check_output(["go", "run", "."], text=True).strip() == "42"
assert os.access(os.environ["GOCACHE"], os.W_OK), "shared cache is not writable"
(Path(os.environ["HOME"]) / "private-home-probe").write_text("permitted")

# Proxy mode must not become an egress or filesystem bypass.
assert os.environ.get("HTTP_PROXY"), "managed proxy was not installed"
for url in ("http://example.com/", "https://example.com/"):
    try:
        urllib.request.urlopen(url, timeout=5)
    except urllib.error.HTTPError as error:
        assert error.code == 403, error.code
    except urllib.error.URLError as error:
        # HTTPS CONNECT reports the proxy's denial as a tunnel error.
        assert "403" in str(error.reason), str(error.reason)
    else:
        raise AssertionError("unlisted host was reachable")
try:
    connection = socket.create_connection(("1.1.1.1", 443), timeout=3)
except OSError:
    pass
else:
    connection.close()
    raise AssertionError("direct TCP escaped the proxy")

# Daemon state outside the workspace, home, and caches stays read-only, even
# though the service account itself could write there.
for outside in (Path("/data/must-not-write"), Path("/data/home/must-not-write")):
    try:
        outside.write_text("not permitted")
    except OSError:
        pass
    else:
        outside.unlink()
        raise AssertionError(f"write outside the sandbox succeeded: {outside}")
print("Offline pins, Node/Git subprocesses, and cached Go builds work; proxy and filesystem boundaries hold.")
