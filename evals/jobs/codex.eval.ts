import { defineEval } from "eve/evals";
import { asJob, stubsFor } from "../stubs.ts";

export default defineEval({
  description: "Asking for Codex starts the job on Codex, leaving its model and effort to Codex's defaults.",
  async test(t) {
    const session = await t.session({ stubs: stubsFor("codex gpt-6.2-sol/high") });
    const turn = await session.send(
      "Have Codex fix the flaky checkout test on the website that times out in CI.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        const onCodex = job.harness === "codex" || /gpt|sol/i.test(job.model ?? "");
        return job.repo === "web" && onCodex && job.effort === undefined;
      },
    });
  },
});
