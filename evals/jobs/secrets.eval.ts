import { defineEval } from "eve/evals";
import { reportMessage } from "../../lib/board-jobs.ts";
import { stubs } from "../stubs.ts";

const failed = reportMessage(
  {
    id: "813",
    state: "failed",
    title: "Triage the Linear backlog",
    repo: "player.games-app",
    kind: "investigate",
    runsOn: "opencode openai/gpt-6-luna-fast/medium",
    heldBy: null,
    result: null,
    reason:
      "MCP servers need LINEAR_API_KEY, which this repo's secrets don't have. Ask in Slack to set them.",
    question: null,
    createdAt: "2026-11-20T00:00:00Z",
    origin: undefined,
    subscription: null,
    waitingUntil: null,
  },
  "",
);

export default defineEval({
  description: "A job that failed for a missing secret gets a request_secret button, not a retry.",
  async test(t) {
    const session = await t.session({ stubs });
    const turn = await session.send(failed);
    turn.expectOk();
    turn.calledTool("request_secret", {
      count: 1,
      input: (input: unknown) => {
        const asked = (input ?? {}) as { repo?: string; name?: string };
        return asked.repo === "player.games-app" && asked.name === "LINEAR_API_KEY";
      },
    });
    turn.notCalledTool("start_job");
  },
});
