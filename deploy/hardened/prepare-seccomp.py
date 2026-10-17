#!/usr/bin/env python3
"""Derive the hardened Codex profile from a pinned, checksum-verified Docker default."""
import hashlib
import json
import pathlib
import sys
import urllib.request

REVISION = "2ceae35d351c156cb5a8efc0fdc4a08cf94569d8"
SHA256 = "6416b47770785a41ac59073cdc77d9fe98517df2799dc83ef207e622de3053f6"
BASE = f"https://raw.githubusercontent.com/moby/profiles/{REVISION}"
with urllib.request.urlopen(f"{BASE}/seccomp/default.json", timeout=30) as response:
    source = response.read()
if hashlib.sha256(source).hexdigest() != SHA256:
    raise SystemExit("Docker seccomp source checksum mismatch")
profile = json.loads(source)
# Kernel capability checks still apply. These operations are needed inside
# bubblewrap's unprivileged namespaces, not the initial container namespace.
extra = {"clone", "clone3", "unshare", "setns", "mount", "umount2", "pivot_root"}
rules = []
for rule in profile["syscalls"]:
    rule["names"] = [name for name in rule["names"] if name not in extra]
    if rule["names"]:
        rules.append(rule)
rules.append({"names": sorted(extra), "action": "SCMP_ACT_ALLOW"})
profile["syscalls"] = rules
output = pathlib.Path(sys.argv[1])
output.write_text(json.dumps(profile, indent=2) + "\n")
with urllib.request.urlopen(f"{BASE}/LICENSE", timeout=30) as response:
    output.with_suffix(".LICENSE").write_bytes(response.read())
print("Prepared Docker-default-based seccomp profile with namespace exceptions")
