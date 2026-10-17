#!/usr/bin/env python3
"""Exercise the deterministic example over HTTP. No inference or remote writes."""
import argparse
import json
import os
from pathlib import Path
import time
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--url", default="http://127.0.0.1:8741")
args = parser.parse_args()
token = os.environ["KILN_TOKEN"]


def api(method, path, body=None):
    request = urllib.request.Request(
        args.url + path,
        data=None if body is None else json.dumps(body).encode(),
        method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


api("POST", "/v1/workflows", {"yaml": Path("examples/retry.yaml").read_text()})
run = api("POST", "/v1/runs", {"workflow_id": "repair-demo"})
for _ in range(200):
    run = api("GET", "/v1/runs/" + run["id"])
    if run["status"] == "waiting":
        break
    if run["status"] in {"failed", "interrupted", "canceled"}:
        raise RuntimeError(run)
    time.sleep(0.05)
assert run["status"] == "waiting", run
assert run["visits"]["build"] == 2
api("POST", f"/v1/runs/{run['id']}/decisions", {
    "question_id": run["question"]["id"], "choice": "approve", "comment": "Smoke test approval"
})
for _ in range(200):
    run = api("GET", "/v1/runs/" + run["id"])
    if run["status"] == "succeeded":
        break
    time.sleep(0.05)
assert run["status"] == "succeeded", run
assert api("GET", "/v1/status")["healthy"]
api("DELETE", f"/v1/runs/{run['id']}/workspace")
print(json.dumps({"run_id": run["id"], "status": run["status"], "checks": ["repair loop", "human gate", "health", "cleanup"]}))
