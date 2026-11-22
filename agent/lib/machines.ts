// The agent's handle on boat: launching job machines and writing repo secrets.
// Reads BOAT_API_KEY, KILN_WORKER_CODE, and the WORKER_* settings from the
// Vercel project's environment.

import { Boat } from "../../lib/boat.ts";
import { type Log, launchConfig, type MachineDeps, reconcileMachines } from "../../lib/machines.ts";
import { team } from "./board.ts";

export const log: Log = (event, fields = {}) => console.info(JSON.stringify({ event, ...fields }));

/** boat, or why it isn't configured. */
export function boatClient(): Boat | string {
  const key = process.env.BOAT_API_KEY;
  return key ? new Boat(key) : "set BOAT_API_KEY on the agent's Vercel project";
}

export function machineDeps(notify?: MachineDeps["notify"]): MachineDeps | string {
  const boat = boatClient();
  if (typeof boat === "string") return boat;
  return { team, boat, config: launchConfig(process.env), log, ...(notify ? { notify } : {}) };
}

/**
 * Reconciles now, so a new job's machine starts right away instead of at the next minute. A failure
 * here only costs that minute, so it is logged, not thrown.
 */
export async function launchNow(): Promise<void> {
  const deps = machineDeps();
  if (typeof deps === "string") {
    log("machines.unconfigured", { problem: deps });
    return;
  }
  try {
    await reconcileMachines(deps);
  } catch (error) {
    log("machines.reconcile_failed", { error: String(error) });
  }
}
