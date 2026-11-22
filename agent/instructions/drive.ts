// Before each turn, the agent sees its drive's AGENTS.md: its conventions,
// which point to INDEX.md, its map of the drive. A user-role instruction joins
// the conversation only when AGENTS.md changes, which is rare, so the prompt
// cache holds. INDEX.md changes often, so the agent reads it when it needs to.

import { defineDynamic, defineInstructions } from "eve/instructions";
import { turnContext } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(`drive-index:${ctx.session.id}:${ctx.turn?.id ?? "start"}`, async () => {
    try {
      return await turnContext(await drive());
    } catch (error) {
      console.error(JSON.stringify({ event: "drive.index_failed", error: String(error) }));
      return "";
    }
  });
  return content ? defineInstructions({ content, role: "user" }) : null;
});
