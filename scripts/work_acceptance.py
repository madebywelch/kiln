#!/usr/bin/env python3
"""Opt-in, BILLABLE Agent37/OpenRouter durable-work acceptance; no GitHub calls.

Run from the repository root with a freshly built bin/kiln. --offline-check only
creates and validates the disposable fixture/workflows; it never starts a daemon
or contacts a provider. The driver simulates test approval, not production approval.
"""
import argparse
from decimal import Decimal, InvalidOperation
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


OPENROUTER = "https://openrouter.ai/api/v1"
AGENT37 = "https://api.agent37.com/v1"
EXEC = "https://sandbox.agent37.app/v1"
MODEL_REQUESTS = 102
MAX_OUTPUT = 8192
MACHINE_RESERVE = Decimal("0.50")


def money(value):
    try:
        amount = Decimal(str(value))
    except InvalidOperation as error:
        raise ValueError("expected a dollar amount") from error
    if not amount.is_finite() or amount < 0:
        raise ValueError("expected a finite nonnegative dollar amount")
    return amount


def cost_bound(model):
    context = int(model["context_length"])
    if context < MAX_OUTPUT:
        raise ValueError("model context is smaller than Pi's output allowance")
    pricing = {key: money(value) for key, value in model["pricing"].items()}
    if any(value for key, value in pricing.items()
           if key not in {"prompt", "completion", "request", "input_cache_read", "input_cache_write"}):
        raise ValueError("model has additional pricing that this driver cannot bound")
    prompt = max(pricing["prompt"], pricing.get("input_cache_read", Decimal(0)),
                 pricing.get("input_cache_write", Decimal(0)))
    return MODEL_REQUESTS * (context * prompt + MAX_OUTPUT * pricing["completion"]
                             + pricing.get("request", Decimal(0)))


def workflows(source, model, test_hash):
    test = f"printf '%s  test_intervals.py\\n' {test_hash} | sha256sum -c - && PYTHONDONTWRITEBYTECODE=1 python3 -m unittest -v"
    setup = """set -eu
mkdir -p /tmp/kiln-acceptance-bin
node_path=$(command -v node)
npm_path=$(command -v npm)
ln -sf "$node_path" /tmp/kiln-acceptance-bin/node
ln -sf "$npm_path" /tmp/kiln-acceptance-bin/npm
export PATH="/tmp/kiln-acceptance-bin:$(dirname "$node_path"):$PATH"
if [ "$(pi --version 2>/dev/null || true)" = 1.5.0 ]; then
  ln -sf "$(command -v pi)" /tmp/kiln-acceptance-bin/pi
else
  npm install --prefix /tmp/kiln-acceptance-pi --no-audit --no-fund @earendil-works/pi-coding-agent@1.5.0
  ln -sf /tmp/kiln-acceptance-pi/node_modules/.bin/pi /tmp/kiln-acceptance-bin/pi
fi
test "$(/tmp/kiln-acceptance-bin/pi --version)" = 1.5.0
node --version
"""
    verify = """python3 - <<'PY'
import json, os, pathlib, re
c = json.loads(pathlib.Path(os.environ['KILN_CONTEXT_FILE']).read_text())
w = c['work']
p = json.loads((pathlib.Path(os.environ['KILN_ARTIFACT_DIR']) / 'handoff-proof.json').read_text())
token = re.search(r'continuity_token=([0-9a-f]+)', w['handoff']['next_action']).group(1)
assert p == {'work_id': w['id'], 'previous_run_id': w['previous_run']['id'], 'handoff_token': token}, 'handoff proof differs from pinned context'
print('Pinned handoff proof verified')
PY"""
    common = {"version": 1, "entry": "start", "exit": "end", "max_steps": 12,
              "repository": {"local": str(source), "base": "main"},
              "sandbox": {"provider": "agent37", "type": "default", "template": "agent37-pi",
                          "resources": {"cpu": 2, "memory": 4, "disk": 6}}}
    first = {**common, "name": "work-interruption", "nodes": {
        "start": {"type": "start", "next": {"success": "test"}},
        "test": {"type": "command", "command": test, "timeout": "2m", "max_visits": 1,
                 "next": {"success": "end", "failure": "hold"}},
        "hold": {"type": "command", "command": 'printf holding > "$KILN_ARTIFACT_DIR/hold-marker"; printf holding; sleep 300',
                 "timeout": "6m", "max_visits": 1, "next": {"success": "end"}},
        "end": {"type": "end"}}}
    second = {**common, "name": "work-replacement", "nodes": {
        "start": {"type": "start", "next": {"success": "setup"}},
        "setup": {"type": "command", "command": setup, "timeout": "5m", "max_visits": 1,
                  "next": {"success": "repair"}},
        "repair": {"type": "agent", "provider": "openrouter", "model": model,
                   "timeout": "10m", "max_visits": 1,
                   "env": {"PATH": "/tmp/kiln-acceptance-bin:/usr/local/bin:/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"},
                   "prompt": "Before doing anything, READ the JSON file named by KILN_CONTEXT_FILE with a tool. Read its work object, handoff, previous_run and acceptance criteria. Read test_intervals.py and intervals.py. Repair ONLY intervals.py without changing tests or adding repository files. Merge touching endpoints and preserve input independence. Extract the continuity_token from work.handoff.next_action and write $KILN_ARTIFACT_DIR/handoff-proof.json with exactly work_id (work.id), previous_run_id (work.previous_run.id), and handoff_token (that token). You must extract these from the context, not guess. Run python3 -m unittest -v. Do not print environment variables, credentials, or the continuity token. There is one agent invocation and no retry.",
                   "next": {"success": "verify"}},
        "verify": {"type": "command", "command": test + " && " + verify, "timeout": "2m", "max_visits": 1,
                   "next": {"success": "candidate"}},
        "candidate": {"type": "changeset", "files": ["intervals.py"], "command": test + " && " + verify,
                      "title": "fix(intervals): preserve inputs and merge touching ranges",
                      "body": "Repair interval merging without modifying tests.\n\nValidation: unchanged unit tests and pinned handoff proof pass in a clean candidate checkout.",
                      "timeout": "3m", "max_visits": 1, "next": {"success": "approve"}},
        "approve": {"type": "human", "prompt": "TEST ONLY: approve candidate {{ .run.candidate.commit_sha }}?",
                    "choices": ["testdriver-approve", "reject"], "next": {"testdriver-approve": "end", "reject": "reject"}},
        "reject": {"type": "command", "command": "exit 1", "next": {"success": "end"}},
        "end": {"type": "end"}}}
    return first, second


class Driver:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.artifacts).resolve()
        self.root.mkdir(parents=True, mode=0o700, exist_ok=False)
        self.binary = Path("bin/kiln").resolve()
        self.daemon = None
        self.log_thread = None
        self.token = secrets.token_hex(32)
        self.secret_values = sorted({value for name, value in os.environ.items()
                                     if value and re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", name, re.I)}
                                    | {self.token}, key=len, reverse=True)
        self.deadline = time.monotonic() + 1500
        self.next_cost_check = 0
        self.spend_limit = min(money(args.budget), money(args.max_spend if args.max_spend is not None else args.budget))
        self.report = {"status": "failed", "assertions": [], "runs": {}, "run_ids": [], "machines": {},
                       "cleanup": [], "publication": "NOT TESTED: no GitHub repository, push, or PR",
                       "approval": "simulated explicit acceptance-test approval, not production approval",
                       "budget_usd": str(args.budget), "max_spend_usd": str(self.spend_limit),
                       "provider_cost": "Not measured by OpenRouter /key; $0.50 reserved, not a provider billing cap"}
        self.persist()

    def redact(self, value):
        for secret in self.secret_values:
            value = value.replace(secret, "[REDACTED]")
        return value

    def save(self, name, value):
        text = value if isinstance(value, str) else json.dumps(value, indent=2)
        target = self.root / name
        temporary = target.with_name(target.name + ".tmp")
        temporary.write_text(self.redact(text))
        temporary.replace(target)

    def persist(self):
        self.save("report.json", self.report)

    def check(self, condition, description):
        if not condition:
            raise RuntimeError("Assertion failed: " + description)
        self.report["assertions"].append(description)
        self.persist()

    def command(self, args, cwd=None):
        result = subprocess.run(args, cwd=cwd, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        if result.returncode:
            raise RuntimeError(f"{args[0]} failed ({result.returncode}): {result.stderr}")
        return result.stdout.strip()

    def http(self, method, url, body=None, key=None, expected=(200,), raw=False, header="Authorization"):
        headers = {"Content-Type": "application/json"}
        if key:
            headers[header] = "Bearer " + key if header == "Authorization" else key
        request = urllib.request.Request(url, method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            data = response.read()
            if response.status not in expected:
                cause = " (provider permission/funding refusal; no retry or top-up)" if response.status in (402, 403) else ""
                raise RuntimeError(self.redact(f"{method} {urllib.parse.urlparse(url).path}: HTTP {response.status}{cause}: {data.decode(errors='replace')[:4000]}"))
            return response.status, data if raw else json.loads(data) if data else None

    def api(self, method, path, body=None, expected=200, raw=False):
        return self.http(method, self.base + path, body, self.token, (expected,), raw)[1]

    def provider(self, method, path, expected=(200,), body=None):
        return self.http(method, AGENT37 + path, body, os.environ["AGENT37_API_KEY"], expected)

    def usage(self):
        data = self.http("GET", OPENROUTER + "/key", key=os.environ["OPENROUTER_API_KEY"])[1]["data"]
        return {key: data.get(key) for key in ("usage", "limit", "limit_remaining", "is_free_tier")}

    def monitor(self):
        if time.monotonic() >= self.deadline:
            raise TimeoutError("25 minute acceptance deadline exceeded")
        if time.monotonic() >= self.next_cost_check:
            current = self.usage()
            self.report["cost"]["latest"] = current
            delta = money(current["usage"]) - money(self.report["cost"]["before"]["usage"])
            self.report["cost"]["usage_delta_usd"] = str(delta)
            self.persist()
            if delta + MACHINE_RESERVE >= self.spend_limit:
                raise RuntimeError("OpenRouter usage delta exhausted remaining budget reserve; refusing further execution")
            self.next_cost_check = time.monotonic() + 10

    def wait(self, description, probe, seconds=300):
        deadline = min(self.deadline, time.monotonic() + seconds)
        while time.monotonic() < deadline:
            self.monitor()
            value = probe()
            if value:
                return value
            time.sleep(1)
        raise TimeoutError("Timed out: " + description)

    def log_output(self, process):
        with (self.root / "daemon.log").open("a") as log:
            for line in process.stdout:
                log.write(self.redact(line))
                log.flush()

    def start(self):
        self.daemon = subprocess.Popen([str(self.binary), "serve", "-config", str(self.root / "server.yaml")],
                                       env={**os.environ, "KILN_TOKEN": self.token}, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, text=True)
        self.log_thread = threading.Thread(target=self.log_output, args=(self.daemon,), daemon=True)
        self.log_thread.start()
        def ready():
            if self.daemon.poll() is not None:
                raise RuntimeError("daemon exited; inspect redacted daemon.log")
            try:
                return self.api("GET", "/healthz") or True
            except (OSError, RuntimeError):
                return False
        self.wait("daemon health", ready, 30)

    def stop(self, crash=False):
        if self.daemon is not None:
            if self.daemon.poll() is None:
                self.daemon.send_signal(signal.SIGKILL if crash else signal.SIGTERM)
                try:
                    self.daemon.wait(timeout=20)
                except subprocess.TimeoutExpired:
                    self.daemon.kill()
                    self.daemon.wait(timeout=5)
            if self.log_thread:
                self.log_thread.join(timeout=5)
            self.daemon.stdout.close()
            self.daemon = None

    def run(self, run_id):
        run = self.api("GET", "/v1/runs/" + run_id)
        self.report["runs"][run_id] = run
        if run.get("sandbox"):
            self.report["machines"][run["sandbox"]["id"]] = {"run_id": run_id}
        self.persist()
        return run

    def wait_run(self, run_id, predicate, description, seconds=600):
        def probe():
            run = self.run(run_id)
            if predicate(run):
                return run
            if run["status"] in {"failed", "interrupted", "canceled"}:
                raise RuntimeError(self.redact("Unexpected terminal run: " + json.dumps(run)))
            return None
        return self.wait(description, probe, seconds)

    def work(self):
        return self.api("GET", "/v1/work/" + self.report["work_id"])

    def submit(self, workflow):
        work = self.work()
        self.report["submit_intent"] = {"workflow_id": workflow["name"], "work_id": work["id"], "work_revision": work["revision"]}
        self.persist()
        run = self.api("POST", "/v1/runs", self.report["submit_intent"])
        self.report["run_ids"].append(run["id"])
        self.report["runs"][run["id"]] = run
        self.persist()
        return run["id"]

    def stopped(self, run_id):
        events = self.api("GET", f"/v1/runs/{run_id}/events?limit=1000")
        failures = [event for event in events if event["type"] == "sandbox.stop_failed"]
        if failures:
            raise RuntimeError("Provider stop failed: " + json.dumps(failures))
        return any(event["type"] == "sandbox.stopped" for event in events)

    def workspace_delete(self, run_id):
        self.wait("sandbox stop event", lambda: self.stopped(run_id), 120)
        run = self.run(run_id)
        machine_id = run["sandbox"]["id"]
        self.owned_instance(machine_id, run_id)
        self.api("DELETE", f"/v1/runs/{run_id}/workspace")
        self.wait("provider confirms deletion", lambda: self.provider("GET", "/instances/" + machine_id, (200, 404))[0] == 404, 60)
        self.report["cleanup"].append({"id": machine_id, "via": "workspace DELETE", "confirmed_404": True})
        self.check(True, "workspace API deletes owned instance and provider confirms 404: " + run_id)

    def owned_instance(self, machine_id, run_id):
        status, instance = self.provider("GET", "/instances/" + machine_id, (200, 404))
        if status == 404:
            return None
        observed_owner = (instance.get("metadata") or {}).get("kiln_run")
        if observed_owner and observed_owner != run_id:
            raise RuntimeError("instance ownership metadata changed; refusing deletion: " + machine_id)
        if observed_owner != run_id:
            listing = self.provider("GET", "/instances")[1]
            instances = listing if isinstance(listing, list) else listing.get("instances", listing.get("data", []))
            match = next((entry for entry in instances if entry.get("id") == machine_id), {})
            if (match.get("metadata") or {}).get("kiln_run") != run_id:
                raise RuntimeError("refusing to delete instance without matching metadata.kiln_run: " + machine_id)
        self.report["machines"][machine_id] = {"run_id": run_id, "metadata_verified": True}
        self.persist()
        return instance

    def prepare(self):
        source = self.root / "source"
        shutil.copytree("testdata/intervals", source, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        self.command(["git", "init", "-b", "main"], source)
        identity = {role: self.command(["git", "var", "GIT_" + role.upper() + "_IDENT"], source).rsplit(">", 1)[0] + ">"
                    for role in ("author", "committer")}
        self.command(["git", "add", "."], source)
        self.command(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "test: seed interval work fixture"], source)
        test_hash = hashlib.sha256((source / "test_intervals.py").read_bytes()).hexdigest()
        first, second = workflows(source, self.args.model, test_hash)
        for workflow in (first, second):
            path = workflow["name"] + ".yaml"
            self.save(path, workflow)
            self.command([str(self.binary), "validate", str(self.root / path)])
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        self.base = f"http://127.0.0.1:{port}"
        self.save("server.yaml", {"listen": f"127.0.0.1:{port}", "data_dir": str(self.root / "state"),
                                  "workers": 1, "allow_local_repositories": True,
                                  "providers": {"openrouter": {"url": OPENROUTER, "key_env": "OPENROUTER_API_KEY"}},
                                  "sandboxes": {"agent37": {"key_env": "AGENT37_API_KEY", "idle_timeout": "5m"}}})
        self.report["versions"] = {"kiln": self.command([str(self.binary), "version"]),
                                   "binary_sha256": hashlib.sha256(self.binary.read_bytes()).hexdigest(),
                                   "git_head": self.command(["git", "rev-parse", "HEAD"]),
                                   "git_status": self.command(["git", "status", "--porcelain"]),
                                   "python": sys.version, "pi_required": "1.5.0"}
        self.report.update({"identity": identity, "original_test_sha256": test_hash,
                            "fixture_base": self.command(["git", "rev-parse", "HEAD"], source),
                            "run_id_durability": "Kiln commits run IDs to this unique SQLite store before dispatch/provisioning; driver snapshots submission responses and recovers store IDs before cleanup"})
        self.persist()
        return first, second

    def preflight(self):
        before = self.usage()
        self.report["cost"] = {"before": before, "reserve_usd": str(MACHINE_RESERVE),
                               "model_requests_bound": MODEL_REQUESTS, "max_output_per_request": MAX_OUTPUT}
        self.persist()
        models = self.http("GET", OPENROUTER + "/models")[1]["data"]
        model = next((model for model in models if model["id"] == self.args.model), None)
        if model is None:
            raise RuntimeError("model absent from public OpenRouter catalog")
        bound = cost_bound(model)
        self.report["cost"].update({"model": {key: model[key] for key in ("id", "context_length", "pricing")},
                                     "worst_case_model_usd": str(bound)})
        self.persist()
        self.check(bound + MACHINE_RESERVE <= self.spend_limit,
                   "102 full-context requests plus 8192 output tokens each fit remaining budget with $0.50 machine reserve")
        if before.get("limit_remaining") is not None:
            self.check(money(before["limit_remaining"]) >= bound, "key remaining allowance covers conservative model bound")

    def execute(self):
        first, second = self.prepare()
        if self.args.offline_check:
            self.report["status"] = "offline-only"
            self.persist()
            return
        self.preflight()
        self.start()
        for workflow in (first, second):
            self.api("POST", "/v1/workflows", {"yaml": json.dumps(workflow)})
        criteria = ["The original unchanged interval unit tests pass in a clean candidate checkout.",
                    "The replacement proves it read the durable handoff and previous run context.",
                    "The validated candidate selects only intervals.py and preserves the fixture tests."]
        work = self.api("POST", "/v1/work", {"title": "Disposable durable interval repair",
                        "objective": "Repair intervals.py using the prior failed build and durable handoff; preserve tests and verify the product candidate.",
                        "acceptance_criteria": criteria})
        self.report["work_id"] = work["id"]
        self.persist()
        original = self.submit(first)
        run = self.wait_run(original, lambda r: r["current"] == "hold" and r["status"] == "running", "first run holding")
        self.check(run["outputs"]["test"]["outcome"] == "failure" and "FAILED" in run["outputs"]["test"]["output"],
                   "real original unittest suite failed remotely")
        failed_build = run["outputs"]["test"]
        marker = run["sandbox"]["home"] + "/kiln/" + original + "/artifacts/hold-marker"
        def holding():
            result = self.http("POST", EXEC + "/instances/" + run["sandbox"]["id"] + "/exec",
                               {"command": "test -f " + shlex.quote(marker) + " && cat " + shlex.quote(marker)},
                               os.environ["AGENT37_API_KEY"], header="X-Agent37-Key")[1]
            return result.get("stdout", "").strip() == "holding"
        self.wait("hold marker actually written on remote instance", holding, 60)
        self.stop(crash=True)
        self.start()
        run = self.wait_run(original, lambda r: r["status"] == "interrupted", "first run interrupted after SIGKILL", 60)
        self.check(holding(), "remote hold marker survives daemon SIGKILL and restart")
        lease = run["sandbox"]["home"] + "/kiln/" + original + "/lease.pid"
        lease_result = self.http("POST", EXEC + "/instances/" + run["sandbox"]["id"] + "/exec",
                                 {"command": "test -f " + shlex.quote(lease) + " && kill -0 \"$(cat " + shlex.quote(lease) + ")\" && printf alive"},
                                 os.environ["AGENT37_API_KEY"], header="X-Agent37-Key")[1]
        self.check(lease_result.get("stdout", "").strip() == "alive", "remote worker lease is still alive after daemon restart")
        self.check(self.work()["status"] == "open", "daemon SIGKILL interrupts run without completing durable work")
        work = self.work()
        self.api("POST", "/v1/runs", {"workflow_id": second["name"], "work_id": work["id"], "work_revision": work["revision"]}, expected=409)
        self.check(True, "replacement rejected with 409 while interrupted worker owns work")
        self.api("POST", f"/v1/runs/{original}/cancel")
        self.workspace_delete(original)
        work = self.work()
        continuity = secrets.token_hex(32)
        handoff = {"progress": "Original remote tests failed; canceled interrupted worker and deleted its instance.",
                   "failed_approaches": ("Actual unittest evidence:\n" + failed_build["output"])[-7000:],
                   "blockers": "The implementation still fails the unchanged test suite.",
                   "next_action": "Read the complete context file, repair only intervals.py, and write proof from the pinned work context. "
                                  + "This handoff follows actual failed-build evidence. " * 8 + "continuity_token=" + continuity}
        work = self.api("PUT", f"/v1/work/{work['id']}/handoff", {"expected_revision": work["revision"], "handoff": handoff})
        self.monitor()
        current_delta = money(self.report["cost"]["latest"]["usage"]) - money(self.report["cost"]["before"]["usage"])
        self.check(current_delta + money(self.report["cost"]["worst_case_model_usd"]) + MACHINE_RESERVE <= self.spend_limit,
                   "remaining budget still covers the full single-agent bound before replacement provisioning")
        replacement = self.submit(second)
        run = self.wait_run(replacement, lambda r: r["status"] == "waiting", "replacement reaches candidate human gate", 1000)
        self.check(run["work_id"] == work["id"] and run["work"]["previous_run"]["id"] == original
                   and run["work"]["handoff"] == handoff, "replacement keeps the same work ID and pinned previous run/handoff")
        self.check(run["visits"].get("repair") == 1, "exactly one repair agent invocation")
        candidate, question = run["candidate"], run["question"]
        verify = next(a for a in run["attempts"] if a["node"] == "candidate")
        completion = {"expected_revision": self.work()["revision"], "run_id": replacement, "approve": True,
                      "summary": "TEST ONLY: driver verified candidate tests, test hash, handoff proof and product selection.",
                      "evidence": [{"criterion": index + 1, "attempt_id": verify["id"]} for index in range(len(criteria))]}
        self.api("POST", f"/v1/work/{work['id']}/complete", completion, expected=409)
        self.check(self.work()["status"] == "open", "work cannot complete before human approval")
        self.stop(crash=True)
        self.start()
        run = self.wait_run(replacement, lambda r: r["status"] == "waiting", "durable human gate restored", 60)
        self.check(run["candidate"] == candidate and run["question"] == question, "SIGKILL preserves exact candidate and question at human gate")
        self.validate_candidate(run, original, continuity)
        self.api("POST", f"/v1/runs/{replacement}/decisions", {"question_id": question["id"], "candidate_id": candidate["id"],
                 "choice": "testdriver-approve", "comment": "Explicit disposable test-driver approval only; not production approval."})
        self.api("POST", f"/v1/runs/{replacement}/decisions", {"question_id": question["id"], "candidate_id": candidate["id"], "choice": "testdriver-approve"}, expected=409)
        run = self.wait_run(replacement, lambda r: r["status"] == "succeeded", "approved run succeeds", 120)
        self.check(all(a["finalized"] and a.get("checkpoint_sha") for a in run["attempts"]),
                   "successful final run has all attempts finalized with durable Git checkpoints")
        self.wait("replacement stop event", lambda: self.stopped(replacement), 120)
        self.check(self.work()["status"] == "open" and not self.work().get("completion"), "successful run leaves work open until explicit CompleteWork")
        completion["expected_revision"] = self.work()["revision"]
        completed = self.api("POST", f"/v1/work/{work['id']}/complete", completion)
        self.check(completed["status"] == "completed" and len(completed["completion"]["evidence"]) == len(criteria)
                   and all(e.get("candidate_id") == candidate["id"] for e in completed["completion"]["evidence"]),
                   "explicit CompleteWork retains candidate verifier evidence for every criterion")
        self.api("POST", f"/v1/runs/{original}/retry", {"acknowledge_side_effects": True}, expected=409)
        self.check(True, "stale original Retry rejected with 409")
        history = self.api("GET", f"/v1/work/{work['id']}/runs")
        self.check([r["id"] for r in history] == [original, replacement] and all(r["work_id"] == work["id"] for r in history),
                   "two linked runs retained in work history")
        self.workspace_delete(replacement)
        history = self.api("GET", f"/v1/work/{work['id']}/runs")
        self.report["history"] = history
        self.stop(crash=True)
        self.start()
        self.check(self.work()["completion"] == completed["completion"]
                   and self.api("GET", f"/v1/work/{work['id']}/runs") == history,
                   "completion evidence and two-run history persist after both cleanups and another restart")
        self.report["work"] = self.work()
        self.report["work_events"] = self.api("GET", f"/v1/work/{work['id']}/events?limit=1000")
        self.report["status"] = "passed"
        self.persist()

    def validate_candidate(self, run, original, continuity):
        candidate = run["candidate"]
        self.check(candidate["files"] == ["intervals.py"] and not candidate["excluded"], "candidate selects only intervals.py with no residue exclusions")
        repo = next((self.root / "state" / "repos").glob("*.git"))
        commit = candidate["commit_sha"]
        self.check(self.command(["git", "rev-list", "--parents", "-n", "1", commit], repo).split() == [commit, run["base_sha"]]
                   and self.command(["git", "rev-list", "--count", run["base_sha"] + ".." + commit], repo) == "1",
                   "single product commit directly on base, without audit ancestry")
        self.check(self.command(["git", "diff", "--name-only", run["base_sha"], commit], repo).splitlines() == ["intervals.py"],
                   "actual product commit changes only intervals.py")
        for role, fmt in (("author", "%an <%ae>"), ("committer", "%cn <%ce>")):
            identity = self.command(["git", "show", "-s", "--format=" + fmt, commit], repo)
            self.check(identity == candidate[role] == self.report["identity"][role], "candidate honors actual configured Git " + role)
        tests = subprocess.run(["git", "show", commit + ":test_intervals.py"], cwd=repo, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout
        self.check(hashlib.sha256(tests).hexdigest() == self.report["original_test_sha256"], "committed tests match original SHA256")
        diff = self.api("GET", f"/v1/runs/{run['id']}/candidate/diff")
        self.save("candidate-diff.json", diff)
        self.check("diff --git a/intervals.py b/intervals.py" in diff["diff"], "candidate diff retrieved through authenticated API")
        proof = self.api("GET", f"/v1/runs/{run['id']}/artifacts/handoff-proof.json", raw=True)
        self.save("handoff-proof.json", proof.decode())
        self.check(json.loads(proof) == {"work_id": run["work_id"], "previous_run_id": original, "handoff_token": continuity},
                   "agent artifact proves extraction of the fresh handoff-only token")
        agent = next(a for a in run["attempts"] if a["node"] == "repair")
        result = agent["result"]
        self.check(result.get("harness") == "pi" and result.get("tool_calls", 0) > 0 and result.get("usage", {}).get("total_tokens", 0) > 0,
                   "real Pi transcript reports tool calls and positive model token usage")
        transcript = self.api("GET", f"/v1/runs/{run['id']}/attempts/{agent['id']}/transcript", raw=True)
        self.save("repair-transcript.jsonl", transcript.decode())
        calls = [json.loads(line) for line in transcript.splitlines() if line.strip()]
        calls = [event for event in calls if event.get("type") == "tool_execution_start"]
        encoded = json.dumps(calls)
        self.check(bool(calls) and ("KILN_CONTEXT_FILE" in encoded or ".context.json" in encoded)
                   and "test_intervals.py" in encoded and "intervals.py" in encoded,
                   "raw agent tool calls read context and fixture source/tests")
        pending = [a for a in run["attempts"] if not a["finalized"]]
        self.check(len(pending) == 1 and pending[0]["node"] == run["question"]["node"]
                   and not pending[0].get("finished_at")
                   and all(a.get("checkpoint_sha") for a in run["attempts"] if a["finalized"]),
                   "only the pending human question lacks a finalized checkpoint at the gate")

    def cleanup(self):
        try:
            if self.daemon is not None and self.daemon.poll() is None and self.report.get("work_id"):
                history = self.api("GET", f"/v1/work/{self.report['work_id']}/runs")
                for summary in history:
                    if summary["id"] not in self.report["run_ids"]:
                        self.report["run_ids"].append(summary["id"])
                    run = self.run(summary["id"])
                    if run["status"] not in {"succeeded", "failed", "canceled"}:
                        self.api("POST", f"/v1/runs/{run['id']}/cancel")
        except Exception as error:
            self.report["cleanup"].append({"discovery_error": self.redact(str(error))})
        finally:
            self.stop()
        database = self.root / "state" / "state.db"
        if database.exists():
            try:
                with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True, timeout=5) as connection:
                    for (document,) in connection.execute("SELECT data FROM documents WHERE kind='run'"):
                        run = json.loads(document)
                        if run["id"] not in self.report["run_ids"]:
                            self.report["run_ids"].append(run["id"])
                        self.report["runs"][run["id"]] = run
                        if run.get("sandbox"):
                            self.report["machines"].setdefault(run["sandbox"]["id"], {"run_id": run["id"]})
                self.persist()
            except Exception as error:
                self.report["cleanup"].append({"discovery_error": "cannot recover owned run IDs from private store: " + self.redact(str(error))})
        if self.args.offline_check or not self.report["run_ids"]:
            return
        try:
            listing = self.provider("GET", "/instances")[1]
            if isinstance(listing, list):
                instances = listing
            else:
                instances = listing.get("instances", listing.get("data"))
                if not isinstance(instances, list) or listing.get("next_cursor") or listing.get("has_more"):
                    raise RuntimeError("unrecognized or paginated instance listing; cannot attest complete discovery")
            discovered = {instance["id"]: instance for instance in instances
                          if (instance.get("metadata") or {}).get("kiln_run") in self.report["run_ids"]}
            for machine_id, machine in self.report["machines"].items():
                discovered.setdefault(machine_id, {"id": machine_id, "metadata": {"kiln_run": machine["run_id"]}})
            for instance in discovered.values():
                owner = (instance.get("metadata") or {}).get("kiln_run")
                if owner not in self.report["run_ids"]:
                    continue
                machine_id = instance["id"]
                self.report["machines"][machine_id] = {"run_id": owner, "metadata_verified": True}
                self.persist()
                try:
                    detail = self.owned_instance(machine_id, owner)
                    if detail is not None:
                        self.provider("DELETE", "/instances/" + machine_id, (200, 202, 204, 404))
                        for _ in range(20):
                            if self.provider("GET", "/instances/" + machine_id, (200, 404))[0] == 404:
                                break
                            time.sleep(1)
                        else:
                            raise RuntimeError("provider did not confirm 404 after deletion")
                    self.report["cleanup"].append({"id": machine_id, "via": "finally metadata-scoped provider DELETE", "confirmed_404": True})
                except Exception as error:
                    self.report["cleanup"].append({"id": machine_id, "confirmed_404": False, "error": self.redact(str(error))})
            confirmed = {entry["id"] for entry in self.report["cleanup"] if entry.get("confirmed_404")}
            for machine_id, machine in self.report["machines"].items():
                if machine_id not in confirmed:
                    status, _ = self.provider("GET", "/instances/" + machine_id, (200, 404))
                    self.report["cleanup"].append({"id": machine_id, "confirmed_404": status == 404,
                                                   "error": "not deleted: ownership could not be verified" if status != 404 else ""})
        except Exception as error:
            self.report["cleanup"].append({"discovery_error": self.redact(str(error))})
        if any(entry.get("discovery_error") or entry.get("confirmed_404") is False for entry in self.report["cleanup"]):
            self.report["status"] = "failed"
            self.report["cleanup_incomplete"] = True
        self.persist()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", required=True, help="fresh private output directory (must not exist)")
    parser.add_argument("--budget", type=money, default=Decimal("10"), help="total approved USD ceiling (default: 10; maximum: 10)")
    parser.add_argument("--max-spend", type=money, help="remaining USD allowance after ALL earlier live runs; defaults to --budget")
    parser.add_argument("--model", default="deepseek/deepseek-v3.2")
    parser.add_argument("--offline-check", action="store_true", help="validate generated workflows locally; no daemon, API, model, or provisioning calls")
    args = parser.parse_args()
    if not 0 < args.budget <= 10 or (args.max_spend is not None and not 0 < args.max_spend <= args.budget):
        parser.error("require 0 < --max-spend <= --budget <= 10")
    if Path(args.artifacts).exists():
        parser.error("--artifacts must name a fresh directory")
    if not args.offline_check:
        for name in ("AGENT37_API_KEY", "OPENROUTER_API_KEY"):
            if not os.environ.get(name):
                parser.error(name + " must be present (value is never printed)")
    os.umask(0o077)
    driver = Driver(args)
    def interrupted(signum, frame):
        raise InterruptedError("acceptance interrupted by signal " + str(signum))
    for signum in (signal.SIGINT, signal.SIGTERM, signal.SIGALRM):
        signal.signal(signum, interrupted)
    signal.alarm(1500)
    try:
        driver.execute()
    except BaseException as error:
        driver.report["error"] = driver.redact(str(error))
        if re.search(r"\b40[23]\b", str(error)):
            driver.report["provider_refusal"] = "HTTP 402/403: provider funding or permission refusal; no automatic retry, budget change, or top-up"
        driver.report["status"] = "failed"
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        try:
            driver.cleanup()
        except BaseException as error:
            driver.report.update({"status": "failed", "cleanup_incomplete": True, "cleanup_error": driver.redact(str(error))})
        if driver.report.get("cost"):
            try:
                after = driver.usage()
                delta = money(after["usage"]) - money(driver.report["cost"]["before"]["usage"])
                driver.report["cost"].update({"after": after, "usage_delta_usd": str(delta)})
                if delta + MACHINE_RESERVE > driver.spend_limit:
                    driver.report.update({"status": "failed", "budget_exceeded": True})
            except Exception as error:
                driver.report.update({"status": "failed", "cost_snapshot_error": driver.redact(str(error))})
        driver.report["elapsed_seconds"] = round(1500 - (driver.deadline - time.monotonic()), 2)
        driver.persist()
    print(json.dumps({"status": driver.report["status"], "report": str(driver.root / "report.json"),
                      "error": driver.report.get("error"), "cleanup_incomplete": driver.report.get("cleanup_incomplete", False)}))
    return 0 if driver.report["status"] in {"passed", "offline-only"} else 1


if __name__ == "__main__":
    sys.exit(main())
