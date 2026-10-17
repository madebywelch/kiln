#!/usr/bin/env python3
"""Minimal stdio MCP fixture; no network or third-party packages."""
import json
import os
import sys

if os.environ.get("FIXTURE_TOKEN") != "local-fixture":
    raise SystemExit("fixture credential missing")

for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    method = request.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": request["params"]["protocolVersion"],
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "kiln-fixture", "version": "1.0.0"},
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "rules", "description": "Read the interval-repair acceptance rules.",
            "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
        }]}
    elif method == "tools/call" and request["params"]["name"] == "rules":
        result = {"content": [{"type": "text", "text": (
            "Merge intervals if next.start <= current.end, never current.end + 1. "
            "Do not mutate or alias inputs. Do not modify tests. "
            "Run python3 -m unittest -v. Include marker KILN-MCP-VERIFIED in your final answer."
        )}]}
    elif method == "ping":
        result = {}
    else:
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"],
                          "error": {"code": -32601, "message": "Method not found"}}), flush=True)
        continue
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)
