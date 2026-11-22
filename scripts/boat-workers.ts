// Looks at the job machines on boat.dev. The agent launches and deletes them
// (lib/machines.ts); these commands only read.
//
//   node scripts/boat-workers.ts status       every job machine: its job, harness, state, and setup
//   node scripts/boat-workers.ts logs <id>    a machine's worker log, by job ID or machine ID
//
// Reads BOAT_API_KEY from .env.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Boat } from "../lib/boat.ts";
import { MACHINE_LABEL, WORKER_LOG_PATH } from "../lib/machines.ts";

/** Reads a dotenv file without interpreting it beyond KEY=value lines. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = match;
    if (key && raw) out[key] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

async function status(boat: Boat): Promise<void> {
  const machines = await boat.machines(MACHINE_LABEL);
  if (machines.length === 0) process.stdout.write("no job machines: nothing is running\n");
  for (const machine of machines) {
    const minutes = Math.round((Date.now() - Date.parse(machine.createdAt)) / 60_000);
    process.stdout.write(
      `${machine.id}  ${(machine.labels?.harness ?? "?").padEnd(8)} ${machine.state.padEnd(8)} setup=${machine.setupStatus ?? "?"}  ${minutes}m  job ${machine.labels?.job ?? "?"}${machine.setupError ? `  ${machine.setupError}` : ""}\n`,
    );
  }
}

async function logs(boat: Boat, id: string | undefined): Promise<void> {
  if (!id) throw new Error("usage: node scripts/boat-workers.ts logs <job id | machine id>");
  const machine = (await boat.machines(MACHINE_LABEL)).find((m) => m.id === id || m.labels?.job === id);
  if (!machine) throw new Error(`no job machine for ${id}; it may have finished and been deleted`);
  process.stdout.write(`${await boat.run(machine.id, `tail -n 100 ~/${WORKER_LOG_PATH}`)}\n`);
}

async function main(): Promise<void> {
  const env = { ...readEnvFile(join(import.meta.dirname, "..", ".env")), ...process.env };
  if (!env.BOAT_API_KEY) throw new Error("set BOAT_API_KEY in .env");
  const boat = new Boat(env.BOAT_API_KEY);
  const [command, argument] = process.argv.slice(2);
  if (command === "status") await status(boat);
  else if (command === "logs") await logs(boat, argument);
  else throw new Error("usage: node scripts/boat-workers.ts status | logs <job id | machine id>");
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
