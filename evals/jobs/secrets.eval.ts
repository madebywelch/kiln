import { defineEval } from "eve/evals";
import { reportMessage } from "../../lib/board-jobs.ts";
import { stubs } from "../stubs.ts";

const failed = reportMessage(
  {
    id: "msg_b799f813-a9d4-40f2-983a-6d9a6ad3dbd1_1",
    ref: "b799f813",
    state: "blocked",
    title: "Triage the Linear backlog",
    repo: "web",
    kind: "investigate",
    runsOn: "opencode openai/gpt-6-luna-fast/medium",
    heldBy: null,
    result: null,
    reason:
      "MCP servers need LINEAR_API_KEY, which this repo's secrets don't have. Ask in Slack to set them.",
    question: null,
    createdAt: "2026-11-20T00:00:00Z",
    origin: undefined,
    secretsNeeded: ["LINEAR_API_KEY"],
    waitingForInference: false,
    workKept: false,
    keptUntil: null,
  },
  "",
);

export default defineEval({
  description: "A job paused for a missing secret gets a request_secret button tied to the job, not a retry.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(failed);
    turn.expectOk();
    turn.calledTool("request_secret", {
      count: 1,
      input: (input: unknown) => {
        const asked = (input ?? {}) as { repo?: string; name?: string; job?: string };
        return (
          asked.repo === "web" &&
          asked.name === "LINEAR_API_KEY" &&
          asked.job?.replace(/^#/, "") === "b799f813"
        );
      },
    });
    turn.notCalledTool("start_job");
    turn.notCalledTool("answer_job");
  },
});
