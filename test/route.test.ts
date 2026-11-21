import { describe, expect, it } from "vitest";
import { CHANNEL_GUIDANCE, type RouteInput, route, THREAD_GUIDANCE } from "../agent/lib/route.ts";

const auth = { authenticator: "slack", principalType: "user", principalId: "U1", attributes: {} } as const;
const history = [{ role: "user" as const, text: "Ada <@U2>: should we theme the site for christmas?" }];

function input(overrides: Partial<RouteInput> = {}): RouteInput & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fromBot: false,
    topLevel: true,
    directMessage: false,
    mentioned: false,
    edit: false,
    auth,
    isSubscribed: async () => {
      calls.push("isSubscribed");
      return false;
    },
    history: async () => {
      calls.push("history");
      return history;
    },
    clearlyNotForRobdog: async () => {
      calls.push("screen");
      return false;
    },
    ...overrides,
  };
}

describe("route", () => {
  it("ignores other bots before doing any work", async () => {
    const i = input({ fromBot: true, mentioned: true });
    expect(await route(i)).toBeNull();
    expect(i.calls).toEqual([]);
  });

  it("drops an unmentioned reply in a thread robdog is not part of", async () => {
    const i = input({ topLevel: false });
    expect(await route(i)).toBeNull();
    expect(i.calls).toEqual(["isSubscribed"]);
  });

  it("drops a top-level message the screen is sure is not for robdog", async () => {
    const i = input({ clearlyNotForRobdog: async () => true });
    expect(await route(i)).toBeNull();
  });

  it("answers a top-level mention with the channel conversation before it, at no screening cost", async () => {
    const i = input({ mentioned: true });
    expect(await route(i)).toEqual({ auth, history });
    expect(i.calls).toEqual(["history"]);
  });

  it("answers a top-level DM with the DM's recent history", async () => {
    expect(await route(input({ directMessage: true }))).toEqual({ auth, history });
  });

  it("answers a mention inside a thread without re-sending history; thread context covers it", async () => {
    const i = input({ mentioned: true, topLevel: false });
    expect(await route(i)).toEqual({ auth });
    expect(i.calls).toEqual([]);
  });

  it("follows a thread robdog is part of, quietly, and lets it choose to stay out", async () => {
    const i = input({ topLevel: false, isSubscribed: async () => true });
    expect(await route(i)).toEqual({ auth, status: "deferred", guidance: THREAD_GUIDANCE });
  });

  it("passes an edit through as a quiet thread message without screening it again", async () => {
    const i = input({ edit: true });
    expect(await route(i)).toEqual({ auth, status: "deferred", guidance: THREAD_GUIDANCE });
    expect(i.calls).toEqual([]);
  });

  it("lets robdog judge an unaddressed channel message, with the conversation, quietly", async () => {
    const i = input();
    expect(await route(i)).toEqual({ auth, status: "deferred", guidance: CHANNEL_GUIDANCE, history });
    expect(i.calls).toEqual(["history", "screen"]);
  });
});
