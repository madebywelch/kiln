import { describe, expect, it } from "vitest";
import {
  firingMessage,
  instantOf,
  isSpent,
  pendingTasks,
  prepareTask,
  ScheduleError,
  type TaskRecord,
} from "../agent/lib/scheduled-task.ts";

const inThread = { channel: { kind: "slack", metadata: { channelId: "C1", threadTs: "1.0", teamId: "T1" } } };

describe("prepareTask", () => {
  it("saves the conversation's thread as where the task reports", () => {
    expect(prepareTask({ task: "check the deploy", post: "thread" }, inThread)).toEqual({
      task: "check the deploy",
      channelId: "C1",
      threadTs: "1.0",
    });
  });

  it("reports as a new message in the channel when asked to", () => {
    expect(prepareTask({ task: "summarize PRs", post: "channel" }, inThread)).toEqual({
      task: "summarize PRs",
      channelId: "C1",
    });
  });

  it("refuses a schedule set outside Slack, since it would have nowhere to report", () => {
    expect(() =>
      prepareTask({ task: "x", post: "thread" }, { channel: { kind: "eve", metadata: {} } }),
    ).toThrow(ScheduleError);
  });
});

describe("firingMessage", () => {
  it("tells the agent it is a scheduled task, not a person, and to act now", () => {
    const message = firingMessage("check the deploy", "deploy check", "2026-11-22T14:00:00Z");
    expect(message).toContain('[scheduled task "deploy check", due 2026-11-22T14:00:00Z');
    expect(message).toContain("not a new message from a person");
    expect(message).toContain("Do it now: check the deploy");
  });
});

describe("pending tasks", () => {
  const now = Date.parse("2026-11-26T15:00:00Z"); // 10:00 in New York
  const once = (name: string, at: string, timezone?: string): TaskRecord => ({
    name,
    state: "active",
    expression: { type: "single", at, ...(timezone ? { timezone } : {}) },
  });

  it("reads a wall-clock time in its timezone, across daylight saving", () => {
    expect(new Date(instantOf("2026-11-26T10:00", "America/New_York")).toISOString()).toBe(
      "2026-11-26T15:00:00.000Z",
    );
    expect(new Date(instantOf("2026-07-01T10:00", "America/New_York")).toISOString()).toBe(
      "2026-07-01T14:00:00.000Z",
    );
    expect(new Date(instantOf("2026-11-26T10:00")).toISOString()).toBe("2026-11-26T10:00:00.000Z");
  });

  it("treats a one-time task whose time passed, or that eve marks completed, as spent; never a recurring one", () => {
    expect(isSpent(once("a", "2026-11-26T09:59", "America/New_York"), now)).toBe(true);
    expect(isSpent(once("b", "2026-11-26T10:01", "America/New_York"), now)).toBe(false);
    expect(isSpent({ ...once("c", "2027-01-01T00:00"), state: "completed" }, now)).toBe(true);
    expect(
      isSpent({ name: "d", state: "active", expression: { type: "cron", cron: "0 9 * * 1-5" } }, now),
    ).toBe(false);
  });

  it("lists only what is still to come, soonest one-time task first, and finds one by its label", () => {
    const records: TaskRecord[] = [
      ...Array.from({ length: 250 }, (_, i) => once(`fired-${i}`, "2026-11-20T09:00", "America/New_York")),
      {
        name: "standup-7f3a",
        displayName: "weekday standup",
        state: "active",
        expression: { type: "cron", cron: "0 9 * * 1-5", timezone: "America/New_York" },
      },
      {
        ...once("merge-pr-1207-91bc", "2026-11-27T09:00", "America/New_York"),
        displayName: "merge PR 1207 if CI is green",
      },
      { ...once("check-deploy-22aa", "2026-11-26T11:00", "America/New_York"), state: "inactive" },
    ];
    expect(pendingTasks(records, now)).toEqual([
      { name: "check-deploy-22aa", runs: "once, 2026-11-26T11:00 America/New_York", disabled: true },
      {
        name: "merge-pr-1207-91bc",
        label: "merge PR 1207 if CI is green",
        runs: "once, 2026-11-27T09:00 America/New_York",
      },
      { name: "standup-7f3a", label: "weekday standup", runs: "cron 0 9 * * 1-5 America/New_York" },
    ]);
    expect(pendingTasks(records, now, "PR 1207").map((task) => task.name)).toEqual(["merge-pr-1207-91bc"]);
  });
});
