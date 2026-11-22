import { defineEval } from "eve/evals";
import { asJob, stubs } from "../stubs.ts";

export default defineEval({
  description: "Work on one repo of a project starts the job on the project, so it gets the whole project.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(
      "The mobile app's backend returns a 500 when a user has no avatar. Fix it so it returns the default avatar.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return job.repo === "mobile" && job.kind === "change";
      },
    });
  },
});
