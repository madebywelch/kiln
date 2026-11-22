// A small client for the boat.dev API: the machines jobs run on, and the
// per-repo environments that hold each repo's secrets. Shared by the agent
// (which launches and deletes machines, and writes secrets) and the operator
// scripts. Takes `fetch` so tests run without the network.

const API = "https://boat.dev/api/v1";

export class BoatError extends Error {
  override readonly name = "BoatError";
  readonly status: number;
  readonly code: string;
  constructor(operation: string, status: number, code: string, message: string) {
    super(`boat ${operation}: ${status} ${code} ${message}`.trim());
    this.status = status;
    this.code = code;
  }
}

export interface Machine {
  readonly id: string;
  readonly name?: string;
  readonly state: string;
  readonly createdAt: string;
  readonly labels?: Readonly<Record<string, string>>;
  /** The setup script's progress: pending, running, done, or failed. */
  readonly setupStatus?: string;
  readonly setupError?: string | null;
}

export interface CreateMachine {
  readonly name: string;
  readonly type: "small" | "default" | "large";
  /** The environment whose secrets the machine gets. */
  readonly environment: string;
  /** Seconds until boat stops the machine on its own: the backstop if nothing deletes it. */
  readonly ttlSeconds: number;
  readonly labels: Readonly<Record<string, string>>;
  readonly files: readonly { readonly path: string; readonly content: string }[];
  readonly setupScript: string;
  /** Makes a retried create return the first machine instead of a second one. */
  readonly idempotencyKey: string;
}

/** What an environment passes to its machines. kiln's repo environments pass secrets and nothing else. */
export interface EnvironmentFlags {
  readonly safeForThirdParties: boolean;
  readonly passGithub: boolean;
  readonly passSecrets: boolean;
  readonly passSandboxCredentials: boolean;
  readonly passAgentsCredentials: boolean;
}

export interface Environment extends EnvironmentFlags {
  readonly id: string;
  readonly name: string;
  /** The environment's variables as a .env file, values included. Never hand this to a model. */
  readonly envContents: string;
}

export type Fetch = typeof fetch;

export class Boat {
  readonly #key: string;
  readonly #fetch: Fetch;

  constructor(key: string, fetchFn: Fetch = fetch) {
    this.#key = key;
    this.#fetch = fetchFn;
  }

  async #call<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.#fetch(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.#key}`, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // not JSON; the status says enough
    }
    if (!response.ok || data.ok === false) {
      throw new BoatError(
        `${method} ${path.split("?")[0]}`,
        response.status,
        String(data.code ?? ""),
        String(data.message ?? ""),
      );
    }
    return data as T;
  }

  async machines(label: Readonly<Record<string, string>> = {}): Promise<Machine[]> {
    const query = Object.entries(label)
      .map(([key, value]) => `label=${encodeURIComponent(`${key}=${value}`)}`)
      .join("&");
    const { sandboxes } = await this.#call<{ sandboxes: Machine[] }>(
      "GET",
      `/sandboxes${query ? `?${query}` : ""}`,
    );
    return sandboxes;
  }

  async createMachine(input: CreateMachine): Promise<Machine> {
    const { idempotencyKey, ...rest } = input;
    const { sandbox } = await this.#call<{ sandbox: Machine }>(
      "POST",
      "/sandboxes",
      // No snapshots: nothing on a job's machine is worth keeping, and a stop erases it.
      { ...rest, snapshots: false },
      { "idempotency-key": idempotencyKey },
    );
    return sandbox;
  }

  async deleteMachine(id: string): Promise<void> {
    await this.#call("DELETE", `/sandboxes/${id}`, undefined, { "x-ascii-confirm-delete": id });
  }

  /** Runs a command on a machine and returns its output; throws on a non-zero exit. */
  async run(id: string, command: string, timeoutSeconds = 60): Promise<string> {
    const result = await this.#call<{ exitCode: number; stdout?: string; stderr?: string }>(
      "POST",
      `/sandboxes/${id}/commands`,
      { command, timeoutSeconds },
    );
    if (result.exitCode !== 0) {
      throw new Error(
        `"${command.slice(0, 80)}" exited ${result.exitCode}: ${(result.stderr || result.stdout || "").slice(-1_500)}`,
      );
    }
    return (result.stdout ?? "").trim();
  }

  async environments(): Promise<Environment[]> {
    return (await this.#call<{ environments: Environment[] }>("GET", "/environments")).environments;
  }

  async createEnvironment(name: string): Promise<Environment> {
    const { environment } = await this.#call<{ environment: Environment }>("POST", "/environments", { name });
    return environment;
  }

  async updateEnvironment(id: string, flags: EnvironmentFlags): Promise<void> {
    await this.#call("PUT", `/environments/${id}`, flags);
  }

  async setVariable(environmentId: string, key: string, value: string): Promise<void> {
    await this.#call("PUT", `/environments/${environmentId}/vars/${encodeURIComponent(key)}`, { value });
  }

  async deleteVariable(environmentId: string, key: string): Promise<void> {
    await this.#call("DELETE", `/environments/${environmentId}/vars/${encodeURIComponent(key)}`);
  }
}

/** The variable names in a .env-style text, never the values. */
export function variableNames(envContents: string): string[] {
  const names: string[] = [];
  for (const line of envContents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match?.[1]) names.push(match[1]);
  }
  return [...new Set(names)].sort();
}
