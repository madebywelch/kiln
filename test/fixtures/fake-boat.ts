// An in-memory boat API for tests: machines and environments, as fetch.
// Honors idempotency keys the way boat does: a repeated key returns the first machine.

import type { Fetch } from "../../lib/boat.ts";

export interface FakeMachine {
  id: string;
  name: string;
  state: string;
  createdAt: string;
  labels: Record<string, string>;
  setupStatus: string;
  setupError: string | null;
  environment: string;
  files: { path: string; content: string }[];
  setupScript: string;
  ttlSeconds: number;
  snapshots: boolean;
  /** Commands run on it, in order; `detached` ones were started in the background. */
  commands: { command: string; detached: boolean }[];
  /** Folders made by `mkdir`, which the agent uses as once-per-resume markers. */
  folders: Set<string>;
  resumes: number;
}

export interface FakeEnvironment {
  id: string;
  name: string;
  safeForThirdParties: boolean;
  passGithub: boolean;
  passSecrets: boolean;
  passSandboxCredentials: boolean;
  passAgentsCredentials: boolean;
  vars: Record<string, string>;
}

export class FakeBoat {
  machines: FakeMachine[] = [];
  environments: FakeEnvironment[] = [];
  readonly keys = new Map<string, string>();
  readonly requests: { method: string; path: string }[] = [];
  /** Environment upgrades: which machine, on which environment. */
  readonly upgrades: { environment: string; machine: string }[] = [];
  /** Machines whose saved disk is gone, so a resume fails as boat's does. */
  readonly expired = new Set<string>();
  /** The account setting that refuses machines with snapshots. */
  snapshotsOff = false;
  #next = 0;
  now = () => new Date().toISOString();

  readonly fetch: Fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const headers = new Headers(init?.headers);
    this.requests.push({ method, path });
    const ok = (data: unknown, status = 200) => Response.json(data, { status });
    const fail = (status: number, code: string) =>
      Response.json({ ok: false, code, message: code }, { status });

    if (method === "GET" && path === "/sandboxes") {
      const filters = url.searchParams.getAll("label").map((pair) => pair.split("="));
      return ok({
        sandboxes: this.machines.filter((m) =>
          filters.every(([k, v]) => k !== undefined && m.labels[k] === v),
        ),
      });
    }
    if (method === "POST" && path === "/sandboxes") {
      const key = headers.get("idempotency-key");
      const earlier = key ? this.machines.find((m) => m.id === this.keys.get(key)) : undefined;
      if (earlier) return ok({ sandbox: earlier }, 202);
      if (!this.environments.some((e) => e.name === body.environment))
        return fail(400, "unknown_environment");
      if (this.snapshotsOff && body.snapshots !== false) return fail(409, "snapshots_off_for_account");
      const machine: FakeMachine = {
        id: `bx_${++this.#next}`,
        name: body.name,
        state: "provisioning",
        createdAt: this.now(),
        labels: body.labels ?? {},
        setupStatus: "pending",
        setupError: null,
        environment: body.environment,
        files: body.files ?? [],
        setupScript: body.setupScript ?? "",
        ttlSeconds: body.ttlSeconds,
        snapshots: body.snapshots,
        commands: [],
        folders: new Set(),
        resumes: 0,
      };
      this.machines.push(machine);
      if (key) this.keys.set(key, machine.id);
      return ok({ sandbox: machine }, 202);
    }
    const action = /^\/sandboxes\/([^/]+)\/(stop|resume|files|commands)$/.exec(path);
    if (action) {
      const machine = this.machines.find((m) => m.id === action[1]);
      if (!machine) return fail(404, "not_found");
      switch (action[2]) {
        case "stop":
          machine.state = "archived";
          return ok({ type: "sandbox.stopping" }, 202);
        case "resume":
          if (this.expired.has(machine.id)) return fail(409, "snapshot_data_expired");
          if (machine.state !== "archived") return fail(409, "sandbox_running");
          machine.state = "provisioning";
          machine.ttlSeconds = body?.ttlSeconds ?? 3600;
          machine.resumes++;
          return ok({ type: "sandbox.resuming" }, 202);
        case "files":
          if (machine.state === "archived") return fail(409, "machine_not_running");
          machine.files.push({ path: body.path, content: body.content });
          return ok({ ok: true });
        case "commands": {
          if (machine.state === "archived") return fail(409, "machine_not_running");
          machine.commands.push({ command: body.command, detached: body.detached === true });
          if (body.detached) return ok({ processId: "proc_1" }, 202);
          const folder = /mkdir (~\/\.kiln\/started-\S+)/.exec(body.command)?.[1];
          if (folder) {
            const fresh = !machine.folders.has(folder);
            machine.folders.add(folder);
            return ok({ exitCode: 0, stdout: fresh ? "start\n" : "started\n" });
          }
          return ok({ exitCode: 0, stdout: "" });
        }
      }
    }
    const upgrade = /^\/environments\/([^/]+)\/upgrade$/.exec(path);
    if (method === "POST" && upgrade) {
      for (const machine of body.agentIds ?? [])
        this.upgrades.push({ environment: upgrade[1] ?? "", machine });
      return ok({ ok: true });
    }
    const machinePath = /^\/sandboxes\/([^/]+)$/.exec(path);
    if (method === "DELETE" && machinePath) {
      const id = machinePath[1];
      if (headers.get("x-ascii-confirm-delete") !== id) return fail(400, "confirm_delete_required");
      if (!this.machines.some((m) => m.id === id)) return fail(404, "not_found");
      this.machines = this.machines.filter((m) => m.id !== id);
      return ok({ ok: true }, 202);
    }
    if (method === "GET" && path === "/environments") {
      return ok({
        environments: this.environments.map(({ vars, ...rest }) => ({
          ...rest,
          envContents: Object.entries(vars)
            // boat double-quotes a value with spaces or shell symbols, escaping quotes and backslashes.
            .map(([k, v]) => `${k}=${/[\s#?&;$'`"\\]/.test(v) ? `"${v.replace(/["\\]/g, "\\$&")}"` : v}`)
            .join("\n"),
        })),
      });
    }
    if (method === "POST" && path === "/environments") {
      const environment: FakeEnvironment = {
        id: `env_${++this.#next}`,
        name: body.name,
        // boat's default for a new environment: everything passes
        safeForThirdParties: false,
        passGithub: true,
        passSecrets: true,
        passSandboxCredentials: true,
        passAgentsCredentials: true,
        vars: {},
      };
      this.environments.push(environment);
      // Real boat doesn't answer a create with { environment }; kiln must not depend on its shape.
      return ok({ ok: true, type: "environment", id: environment.id });
    }
    const envPath = /^\/environments\/([^/]+)$/.exec(path);
    if (method === "PUT" && envPath) {
      const environment = this.environments.find((e) => e.id === envPath[1]);
      if (!environment) return fail(404, "not_found");
      Object.assign(environment, body);
      return ok({ success: true });
    }
    const varPath = /^\/environments\/([^/]+)\/vars\/([^/]+)$/.exec(path);
    if (varPath) {
      const environment = this.environments.find((e) => e.id === varPath[1]);
      if (!environment) return fail(404, "not_found");
      const key = decodeURIComponent(varPath[2] ?? "");
      if (method === "PUT") environment.vars[key] = body.value;
      if (method === "DELETE") delete environment.vars[key];
      return ok({ success: true });
    }
    return fail(404, "no_route");
  };
}
