// Before each turn, the agent sees its drive's project index, so it knows what
// it is keeping track of without opening anything. A user-role instruction joins
// the conversation only when the index changes, which keeps the prompt cache.

import { defineDynamic, defineInstructions } from "eve/instructions";
import { indexText, projectIndex } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(`drive-index:${ctx.session.id}:${ctx.turn?.id ?? "start"}`, async () => {
    try {
      return indexText(await projectIndex(await drive()));
    } catch (error) {
      console.error(JSON.stringify({ event: "drive.index_failed", error: String(error) }));
      return "";
    }
  });
  return content ? defineInstructions({ content, role: "user" }) : null;
});
