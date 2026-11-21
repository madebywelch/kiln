import { defineEval } from "eve/evals";
import { asJob, stubsFor } from "../stubs.ts";

export default defineEval({
  description: "A harness and effort named in chat reach the job.",
  async test(t) {
    const session = await t.session({ stubs: stubsFor("codex default/high") });
    const turn = await session.send(
      "On player games, use codex at high effort: fix the flaky checkout test that times out in CI.",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return job.repo === "player.games-app" && job.harness === "codex" && job.effort === "high";
      },
    });
  },
});
