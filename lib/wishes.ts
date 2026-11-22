// The wish list: limitations the agent ran into in kiln or eve itself, for the people who build
// kiln to review. Each wish is a task in the board's `wishes` channel, labeled kiln=wish; open
// until someone completes it (built) or fails it (won't build), with a note saying which. When the
// agent runs into the same limitation again, it adds to the open wish instead of filing another.
// Not for a deployment's own business (its workflows, repos, or people): those live in its drive.

import type { Board, MessageView } from "@vercel/board";
import { jobRef } from "./jobs.ts";

export const WISHES_CHANNEL = "wishes";
const WISH_LABEL = { kiln: "wish" } as const;

export interface Wish {
  readonly summary: string;
  /** What the agent was doing, what stopped it, and what would have let it. */
  readonly detail: string;
}

export interface WishView {
  readonly wish: string;
  readonly summary: string;
  readonly state: string;
  readonly createdAt: string;
  /** The note it was completed or failed with. */
  readonly resolution?: string;
}

export class WishError extends Error {}

function viewWish(message: MessageView): WishView {
  const resolution = message.task?.result ?? message.task?.reason;
  return {
    wish: `#${jobRef(message.id)}`,
    summary: message.text.split("\n")[0] ?? "",
    state: message.task?.state ?? "unknown",
    createdAt: message.createdAt,
    ...(resolution ? { resolution } : {}),
  };
}

export async function listWishes(
  team: Board,
  state: "open" | "all" = "open",
  limit = 30,
): Promise<WishView[]> {
  const { tasks } = await team.tasks.list({
    channel: WISHES_CHANNEL,
    state,
    label: WISH_LABEL,
    limit,
    latest: true,
  });
  return tasks.map(({ message }) => viewWish(message));
}

async function resolveWishId(team: Board, named: string): Promise<string> {
  const ref = named.trim().replace(/^#/, "").toLowerCase();
  if (ref.startsWith("msg_")) return ref;
  const { tasks } = await team.tasks.list({
    channel: WISHES_CHANNEL,
    state: "all",
    label: WISH_LABEL,
    limit: 200,
  });
  const match = tasks.find(({ message }) => jobRef(message.id) === ref);
  if (!match) throw new WishError(`no wish #${ref}; list_wishes shows them`);
  return match.message.id;
}

/** Files a wish, or adds this sighting to an open one. Returns the wish. */
export async function makeWish(team: Board, wish: Wish, addsTo?: string): Promise<WishView> {
  if (addsTo) {
    const id = await resolveWishId(team, addsTo);
    await team.reply(id, `${wish.summary}\n\n${wish.detail}`);
    return viewWish((await team.thread(id, { limit: 1 })).message);
  }
  const { task } = await team.tasks.create(WISHES_CHANNEL, {
    text: `${wish.summary}\n\n${wish.detail}`,
    labels: { ...WISH_LABEL },
  });
  return viewWish(task);
}
