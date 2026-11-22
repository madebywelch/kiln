import { type Board, board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { beforeEach, describe, expect, it } from "vitest";
import { listWishes, makeWish, WISHES_CHANNEL } from "../lib/wishes.ts";

let team: Board;

beforeEach(() => {
  team = board({ backend: local({ memory: true }) });
});

const wish = {
  summary: "Can't schedule a check-back from a job-update turn",
  detail:
    "Wanted to merge #1150 once CI was green; had no way to come back later, so I waited for the next message.",
};

describe("the wish list", () => {
  it("files a wish as an open task in the wishes channel, and lists it by its short reference", async () => {
    const filed = await makeWish(team, wish);
    expect(filed).toMatchObject({ summary: wish.summary, state: "ready" });
    expect(filed.wish).toMatch(/^#/);
    expect(await listWishes(team)).toEqual([filed]);
    const { tasks } = await team.tasks.list({ channel: WISHES_CHANNEL, state: "open" });
    expect(tasks[0]?.message.text).toBe(`${wish.summary}\n\n${wish.detail}`);
  });

  it("adds another sighting to an open wish instead of filing a second", async () => {
    const filed = await makeWish(team, wish);
    const again = await makeWish(team, { ...wish, detail: "Again, waiting on #1151." }, filed.wish);
    expect(again.wish).toBe(filed.wish);
    expect(await listWishes(team)).toHaveLength(1);
    const id = (await team.tasks.list({ channel: WISHES_CHANNEL })).tasks[0]?.message.id ?? "";
    const thread = await team.thread(id, { limit: 10 });
    expect(thread.replies.map((reply) => reply.text)).toEqual([
      `${wish.summary}\n\nAgain, waiting on #1151.`,
    ]);
  });

  it("refuses to add to a wish that doesn't exist", async () => {
    await expect(makeWish(team, wish, "#deadbeef")).rejects.toThrow(
      /no wish #deadbeef; list_wishes shows them/,
    );
  });

  it("shows a resolved wish with its note, only when asked for all", async () => {
    const filed = await makeWish(team, wish);
    const id = (await team.tasks.list({ channel: WISHES_CHANNEL })).tasks[0]?.message.id ?? "";
    const claim = await team.as("robert").tasks.claim(id, { lease: 60 });
    await claim.complete("Built: check-backs, on eve's dynamic schedules.");
    expect(await listWishes(team)).toEqual([]);
    expect(await listWishes(team, "all")).toEqual([
      { ...filed, state: "completed", resolution: "Built: check-backs, on eve's dynamic schedules." },
    ]);
  });
});
