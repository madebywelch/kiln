#!/usr/bin/env python3
"""Billable local Pi/DeepSeek acceptance: selected skill + MCP + tests + gate + audit.

Requires pi 1.2.0, OPENROUTER_API_KEY and Git identity. No remote writes.
Usage: python3 scripts/agent_acceptance.py --artifacts .kiln/scoped-agent
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
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", default=".kiln/scoped-agent")
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY is required")
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
    config = {"listen": f"127.0.0.1:{port}", "data_dir": str(root / "state"),
              "allow_local_repositories": True,
              "providers": {"openrouter": {"url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY"}},
              "mcp_servers": {
                  "fixture": {"command": "python3", "args": [str(Path("scripts/fixtures/mcp.py").resolve())],
                              "env": {"FIXTURE_TOKEN": "${KILN_FIXTURE_KEY}"}},
                  "unselected": {"command": "this-command-must-never-run"},
              }}
    config_path = root / "server.yaml"
    config_path.write_text(json.dumps(config))
    workflow = {"version": 1, "name": "scoped-agent", "entry": "start", "exit": "end", "max_steps": 15,
                "repository": {"local": str(source), "base": "main"}, "nodes": {
                    "start": {"type": "start", "next": {"success": "test"}},
                    "test": {"type": "command", "command": "python3 -m unittest -v", "max_visits": 4,
                             "next": {"success": "approve", "failure": "repair"}},
                    "repair": {"type": "agent", "provider": "openrouter", "model": "deepseek/deepseek-v3.2",
                               "skills": ["interval-repair"], "mcp": ["fixture"], "timeout": "5m", "max_visits": 3,
                               "prompt": "Load the interval-repair skill and follow it. Use the fixture MCP rules tool, read the source and tests, repair intervals.py, and run the tests. Do not change tests. Previous test output: {{ .outputs.test.output }}",
                               "next": {"success": "test"}},
                    "approve": {"type": "human", "prompt": "Accept the tested repair?", "choices": ["yes", "no"],
                                "next": {"yes": "end", "no": "reject"}},
                    "reject": {"type": "command", "command": "exit 1", "next": {"success": "end"}},
                    "end": {"type": "end"},
                }}
    (root / "workflow.yaml").write_text(json.dumps(workflow, indent=2))
    base = f"http://127.0.0.1:{port}"

    def request(method, path, body=None, raw=False):
        req = urllib.request.Request(base + path, method=method,
                                     data=None if body is None else json.dumps(body).encode(),
                                     headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=40) as response:
            data = response.read()
            return data if raw else json.loads(data)

    with (root / "daemon.log").open("w") as log:
        daemon = subprocess.Popen([str(Path("bin/kiln").resolve()), "serve", "-config", str(config_path)],
                                  env={**os.environ,
                                       "KILN_TOKEN": token,
                                       "KILN_FIXTURE_KEY": "local-fixture"},
                                  stdout=log, stderr=log)
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
            deadline = time.monotonic() + 600
            last = None
            approved = False
            while time.monotonic() < deadline:
                run = request("GET", "/v1/runs/" + run["id"])
                (root / "run.json").write_text(json.dumps(run, indent=2))
                state = run["status"], run["current"]
                if state != last:
                    print(*state, flush=True)
                    last = state
                if run["status"] == "waiting":
                    assert "KILN-MCP-VERIFIED" in run["outputs"]["repair"]["output"]
                    request("POST", f"/v1/runs/{run['id']}/decisions", {"question_id": run["question"]["id"], "choice": "yes"})
                    approved = True
                elif run["status"] == "succeeded":
                    break
                elif run["status"] in {"failed", "interrupted", "canceled"}:
                    raise RuntimeError(json.dumps(run.get("outputs"), indent=2))
                time.sleep(0.2)
            assert run["status"] == "succeeded" and approved
            assert all(a["finalized"] and a.get("checkpoint_sha") for a in run["attempts"])
            tool_calls = []
            skill_read = False
            for attempt in run["attempts"]:
                if not attempt.get("transcript"):
                    continue
                transcript = request("GET", f"/v1/runs/{run['id']}/attempts/{attempt['id']}/transcript", raw=True)
                (root / (attempt["id"] + ".jsonl")).write_bytes(transcript)
                for line in transcript.splitlines():
                    event = json.loads(line)
                    if event.get("type") == "tool_execution_start":
                        tool_calls.append(event["toolName"])
                        skill_read |= event["toolName"] == "read" and "SKILL.md" in event.get("args", {}).get("path", "")
            assert skill_read and "mcp__fixture__rules" in tool_calls and "bash" in tool_calls
            status = subprocess.check_output(["git", "status", "--porcelain"], cwd=run["workspace"], text=True)
            assert not status
            report = {"run_id": run["id"], "status": run["status"], "checkpoints": len(run["attempts"]),
                      "tool_calls": tool_calls, "skill_read": skill_read, "unselected_mcp_not_loaded": True,
                      "transcript_api": True, "human_gate": approved}
            (root / "report.json").write_text(json.dumps(report, indent=2))
            print(json.dumps(report, indent=2))
        finally:
            daemon.send_signal(signal.SIGTERM)
            try:
                daemon.wait(timeout=20)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()


if __name__ == "__main__":
    main()
