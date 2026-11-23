import { defineEval } from "eve/evals";
import { stubs } from "../stubs.ts";

export default defineEval({
  description:
    "A request for a model on a harness that is off is refused with a Claude model offered, not quietly swapped.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "Use deepseek v4.1 flash to figure out why the website's checkout test is flaky.",
    );
    turn.expectOk();
    turn.notCalledTool("start_job");
    // "Claude Sonnet" offers it as much as "sonnet" does.
    turn.messageIncludes(/sonnet/i);
  },
});
