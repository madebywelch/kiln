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
    clearlyNotForAgent: async () => {
      calls.push("screen");
      return false;
    },
    ...overrides,
  };
}

describe("route", () => {
  it("ignores other bots before doing any work", async () => {
    const i = input({ fromBot: true, mentioned: true });
    expect((await route(i)).result).toBeNull();
    expect(i.calls).toEqual([]);
  });

  it("drops an unmentioned reply in a thread the agent is not part of", async () => {
    const i = input({ topLevel: false });
    expect((await route(i)).result).toBeNull();
    expect(i.calls).toEqual(["isSubscribed"]);
  });

  it("drops a top-level message the screen is sure is not for the agent", async () => {
    const i = input({ clearlyNotForAgent: async () => true });
    expect((await route(i)).result).toBeNull();
  });

  it("answers a top-level mention with the channel conversation before it, at no screening cost", async () => {
    const i = input({ mentioned: true });
    expect((await route(i)).result).toEqual({ auth, history });
    expect(i.calls).toEqual(["history"]);
  });

  it("answers a top-level DM with the DM's recent history", async () => {
    expect((await route(input({ directMessage: true }))).result).toEqual({ auth, history });
  });

  it("answers a mention inside a thread without re-sending history; thread context covers it", async () => {
    const i = input({ mentioned: true, topLevel: false });
    expect((await route(i)).result).toEqual({ auth });
    expect(i.calls).toEqual([]);
  });

  it("follows a thread the agent is part of, quietly, and lets it choose to stay out", async () => {
    const i = input({ topLevel: false, isSubscribed: async () => true });
    expect((await route(i)).result).toEqual({ auth, status: "deferred", guidance: THREAD_GUIDANCE });
  });

  it("passes an edit through as a quiet thread message without screening it again", async () => {
    const i = input({ edit: true });
    expect((await route(i)).result).toEqual({ auth, status: "deferred", guidance: THREAD_GUIDANCE });
    expect(i.calls).toEqual([]);
  });

  it("says why, for the log", async () => {
    expect((await route(input({ fromBot: true }))).reason).toBe("bot");
    expect((await route(input({ topLevel: false }))).reason).toBe("unfollowed-thread");
    expect((await route(input({ topLevel: false, isSubscribed: async () => true }))).reason).toBe(
      "followed-thread",
    );
    expect((await route(input({ clearlyNotForAgent: async () => true }))).reason).toBe("screened-out");
    expect((await route(input({ directMessage: true }))).reason).toBe("addressed");
    expect((await route(input())).reason).toBe("ambient");
  });

  it("lets the agent judge an unaddressed channel message, with the conversation, quietly", async () => {
    const i = input();
    expect((await route(i)).result).toEqual({
      auth,
      status: "deferred",
      guidance: CHANNEL_GUIDANCE,
      history,
    });
    expect(i.calls).toEqual(["history", "screen"]);
  });
});

describe("clearlyNotForAgent", () => {
  it("never screens out a voice note, whose words the screen cannot read", async () => {
    const { clearlyNotForAgent } = await import("../agent/lib/ambient.ts");
    const voiceNote = {
      text: "",
      channelId: "C1",
      ts: "1",
      attachments: [{ id: "F1", type: "audio", name: "audio_message.m4a", mimeType: "audio/mp4" }],
    };
    // Resolves before any decision-model call: no network, no keys.
    await expect(clearlyNotForAgent(voiceNote as never, history)).resolves.toBe(false);
  });
});

describe("nameMatcher", () => {
  it("finds the agent's name, spaced or not, and nothing else", async () => {
    const { nameMatcher } = await import("../agent/lib/ambient.ts");
    const name = nameMatcher("evebot");
    expect(name.test("hey evebot, thoughts?")).toBe(true);
    expect(name.test("Eve bot what do you think")).toBe(true);
    expect(name.test("evebots are great")).toBe(false);
    expect(name.test("Eve's bot")).toBe(false);
    expect(nameMatcher("a.b").test("axb")).toBe(false);
  });
});
