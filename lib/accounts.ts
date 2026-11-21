// The subscriptions jobs run on, and what kiln has learned about each one's usage.
//
// Each subscription has a record on the board, in channel `kiln-accounts`: one
// message whose labels hold its last-seen usage per window and, when a window
// is exhausted, a bench until that window resets. Tokens never go on the board,
// only the subscription's name. The agent picks a subscription per job from
// these records; a worker updates them from what Claude Code reports, and moves
// a job to another subscription when its own runs out. A job's model never changes.

import type { Board, MessageView } from "@vercel/board";
import type { Harness } from "./config.ts";

export const ACCOUNTS_CHANNEL = "kiln-accounts";
const BENCH = "bench.";
const USAGE = "usage.";
const RESET = "reset.";

/** Windows that cap every model on a subscription; any other window caps only the model that hit it. */
const ALL_MODEL_WINDOWS = new Set(["five_hour", "seven_day"]);

export interface Subscription {
  /** The subscription's name: `main`, or the suffix of its variable, lowercased. */
  readonly id: string;
  readonly token: string;
}

/** A subscription a worker may use, with its record on the board. */
export interface WorkerSubscription extends Subscription {
  readonly record: string;
}

const CLAUDE_TOKEN = /^WORKER_CLAUDE_CODE_OAUTH_TOKEN(?:_([A-Za-z0-9_]+))?$/;

/**
 * Claude subscriptions from the agent's environment: `WORKER_CLAUDE_CODE_OAUTH_TOKEN` is `main`, and each
 * `WORKER_CLAUDE_CODE_OAUTH_TOKEN_<NAME>` is `<name>`. In this order jobs fill them: `main` first, then by
 * name, so a subscription's 5-hour window starts only when the ones before it are busy or exhausted.
 */
export function claudeSubscriptions(env: Readonly<Record<string, string | undefined>>): Subscription[] {
  const found: Subscription[] = [];
  for (const [key, value] of Object.entries(env)) {
    const match = CLAUDE_TOKEN.exec(key);
    if (match && value) found.push({ id: (match[1] ?? "main").toLowerCase(), token: value });
  }
  return found.sort((a, b) =>
    a.id === "main" ? -1 : b.id === "main" ? 1 : a.id.localeCompare(b.id, "en", { numeric: true }),
  );
}

/** A model as a label key: `opus`, `claude-fable-5-2`, or `default` when the CLI picks. */
export function modelKey(model: string | undefined): string {
  return (model ?? "default").toLowerCase().replace(/[^a-z0-9.-]/g, "-");
}

export interface AccountState {
  readonly id: string;
  /** The record's message ID on the board. */
  readonly record: string;
  /** Until when (unix seconds) each scope is exhausted: `all`, or a model key. */
  readonly benches: Readonly<Record<string, number>>;
  /** Last-seen use of each window, 0 to 100, and when it resets (unix seconds). */
  readonly usage: Readonly<Record<string, { readonly percent: number; readonly resetsAt: number }>>;
}

export function accountState(message: MessageView): AccountState {
  const benches: Record<string, number> = {};
  const usage: Record<string, { percent: number; resetsAt: number }> = {};
  for (const [key, value] of Object.entries(message.labels)) {
    if (key.startsWith(BENCH)) benches[key.slice(BENCH.length)] = Number(value);
    if (key.startsWith(USAGE)) {
      const window = key.slice(USAGE.length);
      usage[window] = {
        percent: Number.parseFloat(value),
        resetsAt: Number(message.labels[`${RESET}${window}`] ?? 0),
      };
    }
  }
  return { id: message.labels.account ?? "", record: message.id, benches, usage };
}

/** The harness's subscription records by name, as the board has them. */
export async function readLedger(team: Board, harness: Harness): Promise<Map<string, AccountState>> {
  const { threads } = await team.threads({
    channel: ACCOUNTS_CHANNEL,
    label: { kiln: "account", harness },
    limit: 100,
  });
  const states = new Map<string, AccountState>();
  for (const { message } of threads) {
    const state = accountState(message);
    if (state.id) states.set(state.id, state);
  }
  return states;
}

/** The records of these subscriptions, posting one for any that has none yet. Only the agent posts them. */
export async function ledger(
  team: Board,
  harness: Harness,
  ids: readonly string[],
): Promise<Map<string, AccountState>> {
  const states = await readLedger(team, harness);
  for (const id of ids) {
    if (states.has(id)) continue;
    const message = await team.post(ACCOUNTS_CHANNEL, {
      text: `${harness} subscription ${id}`,
      labels: { kiln: "account", harness, account: id },
      noSync: true,
      id: `account-${harness}-${id}`,
    });
    states.set(id, accountState(message));
  }
  return new Map(ids.flatMap((id) => (states.has(id) ? [[id, states.get(id) as AccountState]] : [])));
}

/** Until when a subscription can't run this model, or null when it can now. */
export function benchedUntil(
  state: AccountState,
  model: string | undefined,
  nowSeconds: number,
): number | null {
  const until = Math.max(state.benches.all ?? 0, state.benches[modelKey(model)] ?? 0);
  return until > nowSeconds ? until : null;
}

export type Choice =
  | { readonly kind: "chosen"; readonly id: string }
  /** Some subscription could run it, once one of its jobs finishes. */
  | { readonly kind: "busy" }
  /** Every subscription is out of usage for this model until `until` (unix seconds), the earliest reset. */
  | { readonly kind: "exhausted"; readonly until: number }
  | { readonly kind: "none" };

/** The first subscription, in fill order, that can run the model and has room for another job. */
export function chooseSubscription(
  order: readonly string[],
  states: ReadonlyMap<string, AccountState>,
  load: ReadonlyMap<string, number>,
  model: string | undefined,
  perSubscription: number,
  nowSeconds: number,
): Choice {
  if (order.length === 0) return { kind: "none" };
  let earliest = Number.POSITIVE_INFINITY;
  let anyUsable = false;
  for (const id of order) {
    const state = states.get(id);
    const until = state ? benchedUntil(state, model, nowSeconds) : null;
    if (until !== null) {
      earliest = Math.min(earliest, until);
      continue;
    }
    anyUsable = true;
    if ((load.get(id) ?? 0) < perSubscription) return { kind: "chosen", id };
  }
  return anyUsable ? { kind: "busy" } : { kind: "exhausted", until: earliest };
}

/** What Claude Code reports about a subscription's limits, in a `rate_limit_event`. */
export interface RateLimitInfo {
  readonly status?: string;
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  readonly utilization?: number;
  readonly unifiedWindows?: Readonly<
    Record<string, { readonly utilization?: number; readonly resetsAt?: number; readonly status?: string }>
  >;
}

/**
 * Label changes for a subscription's record from what Claude Code reported: the use of every window it
 * named, and a bench when a window is exhausted. A 5-hour or weekly window benches every model; any
 * other window (a model's own weekly limit) benches only the model the job runs.
 */
export function usageLabels(info: RateLimitInfo, model: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  const windows = { ...(info.unifiedWindows ?? {}) };
  if (info.rateLimitType && !windows[info.rateLimitType]) {
    windows[info.rateLimitType] = {
      ...(info.utilization === undefined ? {} : { utilization: info.utilization }),
      ...(info.resetsAt === undefined ? {} : { resetsAt: info.resetsAt }),
    };
  }
  for (const [window, use] of Object.entries(windows)) {
    if (use.utilization !== undefined) labels[`${USAGE}${window}`] = `${Math.round(use.utilization * 100)}%`;
    if (use.resetsAt !== undefined) labels[`${RESET}${window}`] = String(use.resetsAt);
  }
  if (info.status === "rejected") {
    const scope = info.rateLimitType && !ALL_MODEL_WINDOWS.has(info.rateLimitType) ? modelKey(model) : "all";
    // Without a reset time, try again in an hour rather than hammering an exhausted subscription.
    labels[`${BENCH}${scope}`] = String(info.resetsAt ?? Math.floor(Date.now() / 1000) + 3600);
  }
  return labels;
}
