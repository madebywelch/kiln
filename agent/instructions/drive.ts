// The agent's whole standing prompt is its drive's AGENTS.md: who it is, its
// rules, and the people it works with, editable by the agent and by people.
// kiln keeps no other prompt in code. It is read fresh each turn and sent as
// the system prompt, so the agent always sees one current version.
//
// If the drive can't be read, or AGENTS.md is blank, the agent runs on the starter AGENTS.md rather
// than on no prompt at all, and the failure is logged.

import { defineDynamic, defineInstructions } from "eve/instructions";
import { starterAgentsMd } from "../../lib/agents-starter.ts";
import { turnContext } from "../../lib/drive.ts";
import { drive } from "../lib/drive.ts";

export default defineDynamic(async (ctx) => {
  const content = await ctx.memo(`drive-prompt:${ctx.session.id}:${ctx.turn?.id ?? "start"}`, async () => {
    try {
      const prompt = await turnContext(await drive());
      if (prompt) return prompt;
      console.error(JSON.stringify({ event: "drive.prompt_empty", using: "starter" }));
      return starterAgentsMd();
    } catch (error) {
      console.error(JSON.stringify({ event: "drive.prompt_failed", using: "starter", error: String(error) }));
      return starterAgentsMd();
    }
  });
  return defineInstructions({ content });
});
