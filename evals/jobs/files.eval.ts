import { resolve } from "node:path";
import { defineEval } from "eve/evals";
import { asJob, stubs } from "../stubs.ts";

// Evals are bundled before they run, so resolve from the repo root, where `pnpm eval` runs.
const FAVICON = resolve("evals/fixtures/favicon.png");

export default defineEval({
  description:
    "A file dropped in Slack for a repo goes to the job in start_job's files, and the brief says where.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.sendFile(
      "New favicon for the website. Put it in the repo as public/favicon.png.",
      FAVICON,
      "image/png",
    );
    turn.expectOk();
    turn.calledTool("start_job", {
      count: 1,
      input: (input: unknown) => {
        const job = asJob(input);
        return (
          job.repo === "web" &&
          job.kind === "change" &&
          (job.files ?? []).some((path) => path.endsWith("favicon.png")) &&
          /public\/favicon\.png/.test(job.brief ?? "")
        );
      },
    });
  },
});
