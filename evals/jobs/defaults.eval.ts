import { defineEval } from "eve/evals";
import { asJob, stubs } from "../stubs.ts";

export default defineEval({
  description:
    "A plain change request starts one change job on the right repo and leaves the selection to defaults.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "Add a christmas theme to the website. Light snow on the landing page, nothing heavy.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return (
          job.repo === "web" &&
          job.kind === "change" &&
          job.harness === undefined &&
          job.model === undefined &&
          job.effort === undefined &&
          /snow/i.test(job.brief ?? "")
        );
      },
    });
  },
});
