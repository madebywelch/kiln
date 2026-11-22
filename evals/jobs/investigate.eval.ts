import { defineEval } from "eve/evals";
import { asJob, stubsFor } from "../stubs.ts";

export default defineEval({
  description: "A request for findings starts an investigate job, with the model and effort asked for.",
  async test(t) {
    const session = await t.session({ stubs: stubsFor("claude sonnet/low") });
    const turn = await session.send(
      "Have sonnet on low effort figure out why CI is running so slow on the website and propose optimizations.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return (
          job.repo === "web" &&
          job.kind === "investigate" &&
          /sonnet/i.test(job.model ?? "") &&
          job.effort === "low" &&
          (job.harness === undefined || job.harness === "claude")
        );
      },
    });
  },
});
