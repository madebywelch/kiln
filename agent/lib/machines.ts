// The agent's handle on boat: launching job machines and writing repo secrets.
// Reads BOAT_API_KEY, KILN_WORKER_CODE, the WORKER_* settings, and the inference
// endpoint (INFERENCE_*) from the Vercel project's environment.

import { Boat } from "../../lib/boat.ts";
import { keptMachineDays } from "../../lib/config.ts";
import type { Asker } from "../../lib/jobs.ts";
import {
  type InferenceNotices,
  type Log,
  launchConfig,
  type MachineDeps,
  reconcileMachines,
} from "../../lib/machines.ts";
import { readSecretLabels } from "../../lib/secret-labels.ts";
import { team } from "./board.ts";
import { secretLabelStore } from "./drive.ts";
import { DEFAULT_INFERENCE_MODEL } from "./inference.ts";
import { slackApi } from "./slack.ts";

export const log: Log = (event, fields = {}) => console.info(JSON.stringify({ event, ...fields }));

/** boat, or why it isn't configured. */
export function boatClient(): Boat | string {
  const key = process.env.BOAT_API_KEY;
  return key ? new Boat(key) : "set BOAT_API_KEY on the agent's Vercel project";
}

/** A time Slack shows in each reader's own time zone. */
const slackTime = (ms: number) =>
  `<!date^${Math.floor(ms / 1000)}^{time}|${new Date(ms).toISOString().slice(11, 16)} UTC>`;

/**
 * The outage notice, posted straight to the asker's DM through Slack's API: the agent's own turns run on
 * the same endpoint, so while it is rate limited, a turn could say nothing.
 */
export const slackNotices: InferenceNotices = {
  async paused(asker: Asker, until: number) {
    const teamId = asker.issuer?.replace(/^slack:/, "");
    const open = await slackApi("conversations.open", { users: asker.userId }, teamId);
    const channel = String((open.channel as { id?: string } | undefined)?.id ?? "");
    const posted = await slackApi(
      "chat.postMessage",
      {
        channel,
        text: `Inference is rate limited, so jobs are paused until about ${slackTime(until)}. They continue where they stopped once it's back, and queued jobs wait until then. Nothing is lost, and there is nothing to do.`,
      },
      teamId,
    );
    return `${channel}:${String(posted.ts)}${teamId ? `:${teamId}` : ""}`;
  },
  async back(notice: string, since: number) {
    const [channel, ts, teamId] = notice.split(":");
    await slackApi(
      "chat.update",
      {
        channel,
        ts,
        text: `Inference was rate limited from ${slackTime(since)} to ${slackTime(Date.now())}. It's back: paused jobs are continuing where they stopped, and queued jobs are starting.`,
      },
      teamId,
    );
  },
  async gaveUp(notice: string, jobs: readonly string[]) {
    const [channel, ts, teamId] = notice.split(":");
    await slackApi(
      "chat.update",
      {
        channel,
        ts,
        text: `Inference stayed rate limited for a day, so ${jobs.join(", ")} failed. Their work is kept for ${keptMachineDays} days: retrying one continues it where it stopped.`,
      },
      teamId,
    );
  },
};

export function machineDeps(): MachineDeps | string {
  const boat = boatClient();
  if (typeof boat === "string") return boat;
  return {
    team,
    boat,
    config: launchConfig(process.env),
    log,
    notices: slackNotices,
    probeModel: process.env.KILN_MODEL || DEFAULT_INFERENCE_MODEL,
    secretLabels: () => readSecretLabels(secretLabelStore()),
  };
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
