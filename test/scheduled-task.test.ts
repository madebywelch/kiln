import { describe, expect, it } from "vitest";
import { firingMessage, prepareTask, ScheduleError } from "../agent/lib/scheduled-task.ts";

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
