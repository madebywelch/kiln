#!/usr/bin/env python3
"""Billable sandbox acceptance: one remote machine per run, synced checkpoints, stop and delete.

Requires BOAT_API_KEY (--provider boat) or AGENT37_API_KEY (--provider agent37)
for an account that can create machines, and Git identity. With
OPENROUTER_API_KEY the repair step runs Pi inside the machine; without it, pass
--no-agent to repair with a deterministic command. No remote Git writes.
Usage: python3 scripts/sandbox_acceptance.py --artifacts .kiln/sandbox-UNIQUE [--provider agent37]
"""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request

PROVIDERS = {
    "boat": {"api": "https://boat.dev/api/v1", "key": "BOAT_API_KEY", "machine": "/sandboxes/{id}", "state": lambda d: d["sandbox"]["state"],
             "running": {"ready", "idle", "running"}, "stopped": {"archiving", "archived"}},
    "agent37": {"api": "https://api.agent37.com/v1", "key": "AGENT37_API_KEY", "machine": "/instances/{id}", "state": lambda d: d["status"],
                "running": {"running"}, "stopped": {"stopping", "stopped"}},
}


def provider_call(provider, path, method="GET"):
    spec = PROVIDERS[provider]
    req = urllib.request.Request(spec["api"] + path, method=method, headers={"Authorization": "Bearer " + os.environ[spec["key"]]})
    try:
        with urllib.request.urlopen(req, timeout=60) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read() or b"{}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", default=".kiln/sandbox-acceptance")
    parser.add_argument("--provider", default="boat", choices=sorted(PROVIDERS))
    parser.add_argument("--type", default="", help="boat size or agent37 instance type; provider default when omitted")
    parser.add_argument("--snapshot", default="", help="boat named snapshot")
    parser.add_argument("--template", default="", help="agent37 template, for example agent37-pi@<tag>")
    parser.add_argument("--model", default="deepseek/deepseek-v3.2")
    parser.add_argument("--no-agent", action="store_true", help="repair with a command instead of Pi")
    args = parser.parse_args()
    spec = PROVIDERS[args.provider]
    if not os.environ.get(spec["key"]):
        parser.error(spec["key"] + " is required")
    if not args.no_agent and not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY is required unless --no-agent is given")
    root = Path(args.artifacts).resolve()
    if root.exists():
        parser.error("use a fresh artifacts directory")
    root.mkdir(parents=True, mode=0o700)
    source = root / "source"
    shutil.copytree("testdata/intervals", source, ignore=shutil.ignore_patterns("__pycache__"))
    for command in (["git", "init", "-b", "main"], ["git", "add", "."],
                    ["git", "-c", "commit.gpgsign=false", "commit", "-m", "test: seed interval fixture"]):
        subprocess.run(command, cwd=source, check=True, stdout=subprocess.DEVNULL)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token = secrets.token_hex(32)
    config = {"listen": f"127.0.0.1:{port}", "data_dir": str(root / "state"), "allow_local_repositories": True,
              "providers": {"openrouter": {"url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY"}},
              "sandboxes": {args.provider: {"key_env": spec["key"], "idle_timeout": "20m"}}}
    (root / "server.yaml").write_text(json.dumps(config))
    repair = {"type": "agent", "provider": "openrouter", "model": args.model, "timeout": "10m", "max_visits": 2,
              "prompt": "Read intervals.py and test_intervals.py, then repair merge_intervals in place so the tests pass. Only modify intervals.py. Run python3 -m unittest -v to verify. Merge touching endpoints; handle empty, unsorted, negative, nested, duplicate and point intervals; do not mutate inputs. Last test output: {{ .outputs.test.output }}",
              "next": {"success": "test"}}
    if args.no_agent:
        repair = {"type": "command", "max_visits": 2, "next": {"success": "test"}, "command": (
            "python3 - <<'PY'\nimport re\np='intervals.py'\ns=open(p).read()\n"
            "s=s.split('def merge_intervals')[0]+'''def merge_intervals(intervals):\n    merged = []\n"
            "    for start, end in sorted((list(i) for i in intervals), key=lambda i: (i[0], i[1])):\n"
            "        if merged and start <= merged[-1][1]:\n            merged[-1][1] = max(merged[-1][1], end)\n"
            "        else:\n            merged.append([start, end])\n    return merged\n'''\nopen(p,'w').write(s)\nPY")}
    workflow = {"version": 1, "name": "sandbox-acceptance", "entry": "start", "exit": "end", "max_steps": 15,
                "repository": {"local": str(source), "base": "main"},
                "sandbox": {"provider": args.provider, **({"type": args.type} if args.type else {}),
                            **({"snapshot": args.snapshot} if args.snapshot else {}), **({"template": args.template} if args.template else {})},
                "nodes": {
                    "start": {"type": "start", "next": {"success": "probe"}},
                    "probe": {"type": "command", "timeout": "5m",
                              "command": "set -x; uname -a; test -z \"${BOAT_ID-}\"; test -z \"${OPENROUTER_API_KEY-}\"; git --version; python3 --version; pi --version || true; printf probe > \"$KILN_ARTIFACT_DIR/probe.txt\"",
                              "next": {"success": "test"}},
                    "test": {"type": "command", "command": "python3 -m unittest -v", "timeout": "5m", "max_visits": 4,
                             "next": {"success": "candidate", "failure": "repair"}},
                    "repair": repair,
                    "candidate": {"type": "changeset", "files": ["intervals.py"], "command": "python3 -m unittest -v",
                                  "title": "fix(intervals): merge without mutating inputs",
                                  "body": "Repair merge_intervals.\n\nValidation: unit tests pass in a clean candidate checkout inside the run's sandbox.",
                                  "next": {"success": "approve", "failure": "repair"}},
                    "approve": {"type": "human", "prompt": "Accept candidate {{ .run.candidate.commit_sha }}?", "choices": ["yes", "no"],
                                "next": {"yes": "end", "no": "reject"}},
                    "reject": {"type": "command", "command": "exit 1", "next": {"success": "end"}},
                    "end": {"type": "end"},
                }}
    (root / "workflow.yaml").write_text(json.dumps(workflow, indent=2))
    base = f"http://127.0.0.1:{port}"

    def request(method, path, body=None):
        req = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.loads(response.read())

    report = {"provider": args.provider, "checks": []}
    with (root / "daemon.log").open("w") as log:
        daemon = subprocess.Popen([str(Path("bin/kiln").resolve()), "serve", "-config", str(root / "server.yaml")],
                                  env={**os.environ, "KILN_TOKEN": token}, stdout=log, stderr=log)
        try:
            for _ in range(100):
                if daemon.poll() is not None:
                    raise RuntimeError("daemon exited; inspect daemon.log")
                try:
                    request("GET", "/healthz")
                    break
                except OSError:
                    time.sleep(0.05)
            request("POST", "/v1/workflows", {"yaml": json.dumps(workflow)})
            run = request("POST", "/v1/runs", {"workflow_id": workflow["name"]})
            deadline, last, approved = time.monotonic() + 1500, None, False
            while time.monotonic() < deadline:
                run = request("GET", "/v1/runs/" + run["id"])
                (root / "run.json").write_text(json.dumps(run, indent=2))
                state = run["status"], run["current"]
                if state != last:
                    print(*state, flush=True)
                    last = state
                if run["status"] == "waiting":
                    sandbox = run["sandbox"]["id"]
                    status, info = provider_call(args.provider, spec["machine"].format(id=sandbox))
                    assert status == 200 and spec["state"](info) in spec["running"], info
                    report["checks"].append("machine stays running while the run waits for a human")
                    request("POST", f"/v1/runs/{run['id']}/decisions", {"question_id": run["question"]["id"], "candidate_id": run["candidate"]["id"], "choice": "yes"})
                    approved = True
                elif run["status"] == "succeeded":
                    break
                elif run["status"] in {"failed", "interrupted", "canceled"}:
                    raise RuntimeError(run.get("error") + "\n" + json.dumps(run.get("outputs"), indent=2))
                time.sleep(1)
            assert run["status"] == "succeeded" and approved
            sandbox = run["sandbox"]["id"]
            report["sandbox"] = run["sandbox"]
            assert all(a["finalized"] and a.get("checkpoint_sha") for a in run["attempts"])
            remote = [a for a in run["attempts"] if a["result"].get("sandbox")]
            assert remote and all(a["result"]["sandbox"] == sandbox for a in remote)
            assert run["visits"]["test"] >= 2 and run["visits"]["repair"] >= 1
            report["checks"].append("failing build, remote repair, passing build and candidate validation on one machine")
            if not args.no_agent:
                assert run["outputs"]["repair"]["harness"] == "pi" and run["outputs"]["repair"]["tool_calls"] >= 1
                report["checks"].append("Pi tool loop ran inside the machine with OpenRouter inference")
            diff = request("GET", f"/v1/runs/{run['id']}/candidate/diff")
            assert "intervals.py" in diff["diff"]
            probe = urllib.request.urlopen(urllib.request.Request(f"{base}/v1/runs/{run['id']}/artifacts/probe.txt", headers={"Authorization": "Bearer " + token})).read()
            assert probe == b"probe"
            report["checks"].append("remote artifact and candidate diff available through the API")
            for _ in range(60):
                status, info = provider_call(args.provider, spec["machine"].format(id=sandbox))
                if status == 200 and spec["state"](info) in spec["stopped"]:
                    break
                time.sleep(2)
            assert spec["state"](info) in spec["stopped"], info
            report["checks"].append("machine stopped when the run finished")
            # The daemon journals the stop after the terminal transition; cleanup is refused
            # with 409 until that goroutine has finished, so wait for its event first.
            for _ in range(120):
                events = request("GET", f"/v1/runs/{run['id']}/events?limit=1000")
                if any(e["type"] == "sandbox.stopped" for e in events):
                    break
                time.sleep(1)
            assert any(e["type"] == "sandbox.stopped" for e in events), [e["type"] for e in events]
            for attempt in range(30):
                try:
                    request("DELETE", f"/v1/runs/{run['id']}/workspace")
                    break
                except urllib.error.HTTPError as error:
                    if error.code != 409 or attempt == 29:
                        raise
                    time.sleep(1)
            for _ in range(30):
                status, info = provider_call(args.provider, spec["machine"].format(id=sandbox))
                if status == 404:
                    break
                time.sleep(2)
            assert status == 404, info
            report["checks"].append("workspace cleanup deleted the machine")
            events = request("GET", f"/v1/runs/{run['id']}/events?limit=1000")
            report["sandbox_events"] = [e["type"] for e in events if e["type"].startswith("sandbox.") or e["type"] == "workspace.cleaned"]
            report["run_id"] = run["id"]
            (root / "report.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
        finally:
            if daemon.poll() is None:
                daemon.send_signal(signal.SIGTERM)
                try:
                    daemon.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    daemon.kill()
                    daemon.wait()


if __name__ == "__main__":
    main()
