import { defineEval } from "eve/evals";
import { reportMessage } from "../../lib/board-jobs.ts";
import { stubs } from "../stubs.ts";

const update = reportMessage(
  {
    id: "812",
    ref: "812",
    state: "completed",
    title: "Add a christmas theme",
    repo: "web",
    kind: "change",
    runsOn: "claude opus/high",
    heldBy: null,
    result: "Draft PR: https://github.com/acme/web/pull/42",
    reason: null,
    question: null,
    createdAt: "2026-11-20T00:00:00Z",
    origin: undefined,
    subscription: null,
    waitingUntil: null,
    secretsNeeded: null,
  },
  "**Done.** Draft PR: https://github.com/acme/web/pull/42\n\nAdded a snowfall layer to the landing page behind a seasonal flag. Lighthouse unchanged.",
);

export default defineEval({
  description: "A job update from the pool is relayed briefly, with the PR link, and starts nothing new.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(update);
    turn.expectOk();
    turn.notCalledTool("start_job");
    turn.messageIncludes("pull/42");
  },
});
