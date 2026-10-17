#!/usr/bin/env python3
"""Opt-in, billable acceptance test against an existing private GitHub fixture.

Requires OPENROUTER_API_KEY, gh authentication, and codex login. Creates a draft
PR in --repo. The repository must contain testdata/intervals on its main branch.
No credentials are written to artifacts. Run from the project root.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/repo; a private acceptance fixture")
    parser.add_argument("--artifacts", default=".kiln/live-acceptance")
    parser.add_argument("--reviewer-model", required=True, help="Codex model available to the authenticated subscription")
    args = parser.parse_args()
    if not os.environ.get("OPENROUTER_API_KEY"):
        parser.error("OPENROUTER_API_KEY is required")
    repo = json.loads(subprocess.check_output(
        ["gh", "repo", "view", args.repo, "--json", "isPrivate,nameWithOwner"], text=True
    ))
    if not repo["isPrivate"]:
        parser.error("refusing to test against a public repository")
    artifacts = Path(args.artifacts).resolve()
    artifacts.mkdir(parents=True, exist_ok=True, mode=0o700)
    if (artifacts / "state").exists():
        parser.error("use a fresh artifacts directory to avoid repeating old automations")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    token, webhook_secret = secrets.token_hex(32), secrets.token_hex(32)
    env = dict(os.environ, KILN_TOKEN=token, KILN_GITHUB_WEBHOOK_SECRET=webhook_secret)
    config = {
        "listen": f"127.0.0.1:{port}", "data_dir": str(artifacts / "state"), "workers": 2,
        "providers": {"openrouter": {"url": "https://openrouter.ai/api/v1", "key_env": "OPENROUTER_API_KEY"}},
    }
    config_path = artifacts / "server.yaml"
    config_path.write_text(json.dumps(config))
    url = f"http://127.0.0.1:{port}"
    daemon = None
    log = (artifacts / "daemon.log").open("a")

    def api(method, path, body=None, headers=None, expected=200):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url + path, data=data, method=method, headers={
            "Authorization": "Bearer " + token, "Content-Type": "application/json", **(headers or {})
        })
        try:
            response = urllib.request.urlopen(request, timeout=40)
        except urllib.error.HTTPError as error:
            response = error
        content = response.read()
        if response.status != expected:
            raise RuntimeError(f"{method} {path}: {response.status}: {content.decode()}")
        return json.loads(content) if content else None

    def start():
        nonlocal daemon
        daemon = subprocess.Popen([str(Path("bin/kiln").resolve()), "serve", "-config", str(config_path)],
                                  env=env, stdout=log, stderr=log)
        for _ in range(100):
            if daemon.poll() is not None:
                raise RuntimeError("daemon exited; inspect daemon.log")
            try:
                api("GET", "/healthz")
                return
            except (OSError, RuntimeError):
                time.sleep(0.05)
        raise RuntimeError("daemon did not start")

    def stop():
        nonlocal daemon
        if daemon is not None and daemon.poll() is None:
            daemon.send_signal(signal.SIGTERM)
            try:
                daemon.wait(timeout=20)
            except subprocess.TimeoutExpired:
                daemon.kill()
                daemon.wait()
        daemon = None

    def wait(run_id, target, seconds=600):
        deadline, last = time.monotonic() + seconds, None
        while time.monotonic() < deadline:
            run = api("GET", f"/v1/runs/{run_id}")
            state = run["status"], run["current"]
            if state != last:
                print(f"{run_id[:8]}: {state[0]} at {state[1]}", flush=True)
                last = state
            (artifacts / f"run-{run_id}.json").write_text(json.dumps(run, indent=2))
            if run["status"] == target:
                return run
            if run["status"] in {"failed", "interrupted", "canceled"}:
                raise RuntimeError(f"run {run_id}: {run['status']}: {run.get('error')}")
            time.sleep(0.3)
        raise RuntimeError("run timed out")

    report = {"repository": repo["nameWithOwner"], "checks": []}
    try:
        start()
        workflow = Path("examples/multi-provider.yaml").read_text().replace("OWNER/REPO", args.repo).replace("model: gpt-6-sol", "model: " + args.reviewer_model)
        api("POST", "/v1/workflows", {"yaml": workflow})
        request = {"workflow_id": "interval-repair"}
        run = api("POST", "/v1/runs", request, {"Idempotency-Key": "live-run"})
        duplicate = api("POST", "/v1/runs", request, {"Idempotency-Key": "live-run"})
        assert run["id"] == duplicate["id"]
        report["checks"].append("idempotent run submission")
        run = wait(run["id"], "waiting")
        assert run["current"] == "approval", f"unexpected gate: {run.get('question')}"
        assert run["visits"]["build"] >= 2 and run["visits"]["repair"] >= 1
        assert run["outputs"]["repair"]["harness"] == "pi" and run["outputs"]["repair"]["tool_calls"] >= 2
        report["checks"].append("real DeepSeek planning and Pi tool-loop repair after a failing build")
        report["checks"].append(f"subscription-backed Codex {args.reviewer_model} review")
        candidate = run["candidate"]
        assert run["question"]["candidate_id"] == candidate["id"]
        assert candidate["files"] == ["intervals.py"]
        login = subprocess.check_output(
            ["gh", "api", "user", "--hostname", "github.com", "--jq", ".login"], text=True).strip()
        assert candidate["branch"] == f"{login}/fix-intervals"
        assert not (Path(run["workspace"]) / "plan.md").exists()
        diff = api("GET", f"/v1/runs/{run['id']}/candidate/diff")
        assert "intervals.py" in diff["diff"] and not diff["truncated"]
        report["checks"].append("clean candidate checkout and API-visible selected diff")
        question = run["question"]["id"]
        stop()
        start()
        restored = api("GET", f"/v1/runs/{run['id']}")
        assert restored["status"] == "waiting" and restored["question"]["id"] == question
        assert restored["candidate"] == candidate and restored["question"]["candidate_id"] == candidate["id"]
        report["checks"].append("daemon restart preserves pending human gate")
        decision = {"question_id": question, "candidate_id": candidate["id"], "choice": "approve", "comment": "Acceptance test approval"}
        api("POST", f"/v1/runs/{run['id']}/decisions", decision)
        api("POST", f"/v1/runs/{run['id']}/decisions", decision, expected=409)
        run = wait(run["id"], "succeeded")
        assert all(a["finalized"] and a.get("checkpoint_sha") for a in run["attempts"])
        report["checks"].append("Git audit checkpoint for every completed stage attempt")
        report["run_id"] = run["id"]
        report["pull_request"] = run["outputs"]["publish"]["output"]
        pr = json.loads(subprocess.check_output(
            ["gh", "pr", "view", report["pull_request"], "--json",
             "headRefOid,headRefName,commits,files,title,body"], text=True))
        assert pr["headRefOid"] == candidate["commit_sha"] and pr["headRefName"] == candidate["branch"]
        assert len(pr["commits"]) == 1 and pr["commits"][0]["messageHeadline"] == candidate["title"]
        assert sorted(f["path"] for f in pr["files"]) == candidate["files"]
        assert pr["title"] == candidate["title"] and pr["body"].strip() == candidate["body"]
        commit = json.loads(subprocess.check_output(
            ["gh", "api", f"repos/{args.repo}/git/commits/{candidate['commit_sha']}"], text=True))
        assert [p["sha"] for p in commit["parents"]] == [run["base_sha"]]
        assert f"{commit['author']['name']} <{commit['author']['email']}>" == candidate["author"]
        assert commit["message"].strip() == candidate["title"]
        report["candidate"] = candidate
        report["checks"].append("one conventional product commit, configured Git author, concise PR body, no checkpoint ancestry")
        report["inference"] = [a["result"] for a in run["attempts"] if a["result"].get("provider")]
        report["checks"].extend(["stale decision rejected", "GitHub branch push and draft PR"])
        events = api("GET", f"/v1/runs/{run['id']}/events")
        replay = api("GET", f"/v1/runs/{run['id']}/events?after={events[2]['id']}")
        assert replay == events[3:]
        report["checks"].append("durable event cursor replay")

        # Trigger the same deterministic graph through all automation entry points.
        api("POST", "/v1/workflows", {"yaml": Path("examples/retry.yaml").read_text()})
        auto = {"workflow_id": "repair-demo", "event": "github.issues.opened",
                "github_repository": args.repo, "enabled": True}
        api("PUT", "/v1/automations/issues", auto)
        payload = {"action": "opened", "repository": {"full_name": args.repo}, "issue": {"number": 1}}
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(webhook_secret.encode(), body, hashlib.sha256).hexdigest()
        headers = {"X-GitHub-Event": "issues", "X-GitHub-Delivery": "acceptance-delivery",
                   "X-Hub-Signature-256": signature}
        triggered = api("POST", "/v1/webhooks/github", payload, headers)
        duplicate = api("POST", "/v1/webhooks/github", payload, headers)
        assert triggered == duplicate and len(triggered["run_ids"]) == 1
        api("POST", "/v1/webhooks/github", payload, {**headers, "X-Hub-Signature-256": "sha256=00"}, expected=401)
        gate = wait(triggered["run_ids"][0], "waiting", seconds=30)
        api("POST", f"/v1/runs/{gate['id']}/decisions",
            {"question_id": gate["question"]["id"], "choice": "reject"})
        # Rejection deliberately produces a failed terminal run.
        for _ in range(100):
            rejected = api("GET", f"/v1/runs/{gate['id']}")
            if rejected["status"] == "failed":
                break
            time.sleep(0.1)
        assert rejected["status"] == "failed"
        report["checks"].extend(["signed GitHub event trigger", "webhook delivery deduplication",
                                  "invalid webhook signature rejected", "human rejection path"])
        api("PUT", "/v1/automations/scheduled", {"workflow_id": "repair-demo", "schedule": "* * * * *", "enabled": True})
        deadline = time.monotonic() + 75
        while time.monotonic() < deadline:
            scheduled = [r for r in api("GET", "/v1/runs") if r.get("automation_id") == "scheduled"]
            if scheduled:
                break
            time.sleep(0.5)
        assert scheduled, "cron did not fire"
        scheduled_run = wait(scheduled[0]["id"], "waiting", seconds=30)
        api("POST", "/v1/automations/scheduled/fire", expected=409)
        api("POST", f"/v1/runs/{scheduled_run['id']}/cancel")
        api("DELETE", "/v1/automations/scheduled")
        report["checks"].extend(["real cron tick", "automation overlap rejected", "cancel waiting run"])
        (artifacts / "report.json").write_text(json.dumps(report, indent=2))
        print(json.dumps({k: v for k, v in report.items() if k != "inference"}, indent=2))
    finally:
        stop()
        log.close()


if __name__ == "__main__":
    main()
