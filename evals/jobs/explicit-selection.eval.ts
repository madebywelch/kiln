import { defineEval } from "eve/evals";
import { asJob, stubsFor } from "../stubs.ts";

export default defineEval({
  description: "A model and effort named in chat reach the job.",
  async test(t) {
    const session = await t.session({ stubs: stubsFor("claude opus/max") });
    const turn = await session.send(
      "On the website, use opus at max effort: fix the flaky checkout test that times out in CI.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return job.repo === "web" && /opus/i.test(job.model ?? "") && job.effort === "max";
      },
    });
  },
});
