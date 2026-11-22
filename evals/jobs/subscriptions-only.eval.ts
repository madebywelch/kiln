import { defineEval } from "eve/evals";
import { stubs } from "../stubs.ts";

export default defineEval({
  description:
    "A request for a per-token model is refused with a subscription model offered, not quietly swapped.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "Use deepseek v4.1 flash to figure out why the website's checkout test is flaky.",
    );
    turn.expectOk();
    turn.notCalledTool("start_job");
    turn.messageIncludes("sonnet");
  },
});
