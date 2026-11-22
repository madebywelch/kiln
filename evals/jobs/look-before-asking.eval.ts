import { defineEval } from "eve/evals";
import { stubs } from "../stubs.ts";

export default defineEval({
  description:
    "Asked about a doc in a repo, the agent finds and reads it instead of asking for it or starting a job to look.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "In the website repo there's an email CLI with a draft for the upcoming Thanksgiving email. What's the subject line?",
    );
    turn.expectOk();
    turn.calledTool("repo_read");
    turn.notCalledTool("start_job");
    turn.messageIncludes("Gobble");
  },
});
