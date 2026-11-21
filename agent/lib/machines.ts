// The agent's handle on boat: launching job machines and writing repo secrets.
// Reads BOAT_API_KEY, KILN_WORKER_CODE, and the WORKER_* settings from the
// Vercel project's environment.

import type { MessageView } from "@vercel/board";
import { Boat } from "../../lib/boat.ts";
import { type Log, launchConfig, launchMachine, type MachineDeps } from "../../lib/machines.ts";
import { team } from "./board.ts";

export const log: Log = (event, fields = {}) => console.info(JSON.stringify({ event, ...fields }));

/** boat, or why it isn't configured. */
export function boatClient(): Boat | string {
  const key = process.env.BOAT_API_KEY;
  return key ? new Boat(key) : "set BOAT_API_KEY on the agent's Vercel project";
}

export function machineDeps(): MachineDeps | string {
  const boat = boatClient();
  if (typeof boat === "string") return boat;
  return { team, boat, config: launchConfig(process.env), log };
}

/**
 * Starts the job's machine right away instead of at the next reconcile. A failure here only costs the
 * minute until the schedule tries again, so it is logged, not thrown.
 */
export async function launchNow(job: MessageView): Promise<void> {
  const deps = machineDeps();
  if (typeof deps === "string") {
    log("machines.unconfigured", { job: job.id, problem: deps });
    return;
  }
  try {
    await launchMachine(deps, job);
  } catch (error) {
    log("machines.launch_failed", { job: job.id, error: String(error) });
  }
}
