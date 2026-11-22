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
      };
      this.machines.push(machine);
      if (key) this.keys.set(key, machine.id);
      return ok({ sandbox: machine }, 202);
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
            .map(([k, v]) => `${k}=${v}`)
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
      return ok({ environment: { ...environment, envContents: "" } });
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
