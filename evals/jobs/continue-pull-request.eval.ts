import { defineEval } from "eve/evals";
import { asJob, stubs } from "../stubs.ts";

export default defineEval({
  description:
    "A fix for an open pull request continues that pull request, so it stays open, instead of a new job replacing it.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "CI is red on the website's PR #42: the checkout test times out. Fix it on that PR.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return job.repo === "web" && job.kind === "change" && job.pull_request === 42;
      },
    });
  },
});
