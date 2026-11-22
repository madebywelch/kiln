import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { describe, expect, it } from "vitest";
import {
  type AccountState,
  benchedUntil,
  chooseSubscription,
  claudeSubscriptions,
  ledger,
  modelKey,
  readLedger,
  usageLabels,
} from "../lib/accounts.ts";

const NOW = 1_800_000_000;
const state = (id: string, benches: Record<string, number> = {}): AccountState => ({
  id,
  record: `rec-${id}`,
  benches,
  usage: {},
});

describe("claudeSubscriptions", () => {
  it("names each token's subscription and orders main first, then by name", () => {
    const subs = claudeSubscriptions({
      WORKER_CLAUDE_CODE_OAUTH_TOKEN_10: "t10",
      WORKER_CLAUDE_CODE_OAUTH_TOKEN_2: "t2",
      WORKER_CLAUDE_CODE_OAUTH_TOKEN: "tm",
      WORKER_CLAUDE_CODE_OAUTH_TOKEN_VERIFIED: "tv",
      WORKER_CLAUDE_CODE_OAUTH_TOKEN_EMPTY: "",
      WORKER_GH_TOKEN: "not a subscription",
    });
    expect(subs.map((s) => s.id)).toEqual(["main", "2", "10", "verified"]);
    expect(subs[0]?.token).toBe("tm");
  });
});

describe("usageLabels", () => {
  it("records every window Claude Code reported, as a percentage and a reset time", () => {
    expect(
      usageLabels(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.91,
          resetsAt: NOW + 100,
          unifiedWindows: { seven_day: { utilization: 0.91, resetsAt: NOW + 100 } },
        },
        "opus",
      ),
    ).toEqual({ "usage.seven_day": "91%", "reset.seven_day": String(NOW + 100) });
  });

  it("benches every model when the 5-hour or weekly window runs out", () => {
    expect(
      usageLabels({ status: "rejected", rateLimitType: "five_hour", resetsAt: NOW + 60 }, "opus"),
    ).toMatchObject({
      "bench.all": String(NOW + 60),
    });
    expect(
      usageLabels({ status: "rejected", rateLimitType: "seven_day", resetsAt: NOW + 60 }, "opus"),
    ).toMatchObject({
      "bench.all": String(NOW + 60),
    });
  });

  it("benches only the job's model when a model's own weekly window runs out", () => {
    const labels = usageLabels(
      { status: "rejected", rateLimitType: "seven_day_oi", resetsAt: NOW + 60 },
      "claude-fable-5-2",
    );
    expect(labels["bench.claude-fable-5-2"]).toBe(String(NOW + 60));
    expect(labels["bench.all"]).toBeUndefined();
  });

  it("benches everything for an hour when Claude Code said it ran out without saying which window", () => {
    const labels = usageLabels({ status: "rejected" }, "opus");
    expect(Number(labels["bench.all"])).toBeGreaterThan(Date.now() / 1000 + 3500);
  });
});

describe("chooseSubscription", () => {
  const order = ["main", "2", "3"];
  const states = new Map([
    ["main", state("main")],
    ["2", state("2")],
    ["3", state("3")],
  ]);

  it("fills subscriptions in order, up to the jobs each may run", () => {
    expect(chooseSubscription(order, states, new Map(), "opus", 2, NOW)).toEqual({
      kind: "chosen",
      id: "main",
    });
    expect(chooseSubscription(order, states, new Map([["main", 2]]), "opus", 2, NOW)).toEqual({
      kind: "chosen",
      id: "2",
    });
  });

  it("waits for a slot when every usable subscription is full", () => {
    const full = new Map([
      ["main", 2],
      ["2", 2],
      ["3", 2],
    ]);
    expect(chooseSubscription(order, states, full, "opus", 2, NOW)).toEqual({ kind: "busy" });
  });

  it("skips a subscription benched for every model, and one benched for this model only", () => {
    const benched = new Map([
      ["main", state("main", { all: NOW + 600 })],
      ["2", state("2", { opus: NOW + 300 })],
      ["3", state("3")],
    ]);
    expect(chooseSubscription(order, benched, new Map(), "opus", 2, NOW)).toEqual({
      kind: "chosen",
      id: "3",
    });
    expect(chooseSubscription(order, benched, new Map(), "sonnet", 2, NOW)).toEqual({
      kind: "chosen",
      id: "2",
    });
  });

  it("says when the earliest reset is once every subscription is out for this model", () => {
    const out = new Map([
      ["main", state("main", { all: NOW + 600 })],
      ["2", state("2", { opus: NOW + 300 })],
      ["3", state("3", { all: NOW + 900, opus: NOW + 100 })],
    ]);
    expect(chooseSubscription(order, out, new Map(), "opus", 2, NOW)).toEqual({
      kind: "exhausted",
      until: NOW + 300,
    });
  });

  it("treats a bench that has passed as usable again", () => {
    expect(benchedUntil(state("main", { all: NOW - 1 }), "opus", NOW)).toBeNull();
    expect(chooseSubscription([], states, new Map(), "opus", 2, NOW)).toEqual({ kind: "none" });
  });

  it("keys models the way the board's labels allow", () => {
    expect(modelKey("claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(modelKey(undefined)).toBe("default");
    expect(modelKey("Opus 4/x")).toBe("opus-4-x");
  });
});

describe("ledger", () => {
  it("posts one record per subscription, once, and reads benches back from its labels", async () => {
    const team = board({ backend: local({ memory: true }) });
    const first = await ledger(team, "claude", ["main", "2"]);
    const again = await ledger(team, "claude", ["main", "2"]);
    expect([...again.keys()]).toEqual(["main", "2"]);
    expect(again.get("main")?.record).toBe(first.get("main")?.record);

    await team.label(first.get("2")?.record ?? "", {
      set: { "bench.opus": String(NOW + 60), "usage.seven_day": "91%", "reset.seven_day": String(NOW + 60) },
    });
    const read = await readLedger(team, "claude");
    expect(read.get("2")).toMatchObject({
      benches: { opus: NOW + 60 },
      usage: { seven_day: { percent: 91, resetsAt: NOW + 60 } },
    });
  });
});
