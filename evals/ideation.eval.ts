import { defineEval } from "eve/evals";
import { stubs } from "./stubs.ts";

export default defineEval({
  description: "Thinking out loud about a project is a conversation, not a job.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "Thinking about seasonal events for the website. Is a christmas theme worth doing, or is it gimmicky? Give me your honest take.",
    );
    turn.expectOk();
    turn.notCalledTool("start_job");
    turn.messageIncludes(/\w{3,}/);
  },
});
