import type { ToolStub } from "eve/evals";

// Tools that reach Slack or the board return canned results in evals, so a run
// touches nothing real and the assertions see exactly what the agent asked for.
// Every tool that leaves the process is stubbed here; keep it that way.

/** `runsOn` is what the pool reports back; give it the selection the eval expects the agent to ask for. */
export const stubsFor = (runsOn: string): ToolStub[] => [
  {
    id: "start-job",
    tool: "start_job",
    outcome: { response: { id: "812", state: "ready", runsOn, reportsTo: "this thread" } },
  },
  { id: "list-jobs", tool: "list_jobs", outcome: { response: { jobs: [] } } },
  {
    id: "job-details",
    tool: "job_details",
    outcome: { response: { id: "812", state: "ready", title: "the job", log: [] } },
  },
  { id: "cancel-job", tool: "cancel_job", outcome: { response: { id: "812", state: "canceled" } } },
  { id: "answer-job", tool: "answer_job", outcome: { response: { id: "812", state: "ready" } } },
  { id: "history", tool: "slack_history", outcome: { response: { channel: "C0123", messages: [] } } },
  {
    id: "upload",
    tool: "slack_upload",
    outcome: { response: { uploaded: "file", bytes: 1, channel: "C0123" } },
  },
  { id: "react", tool: "slack_react", outcome: { response: { reacted: "eyes" } } },
  { id: "post", tool: "slack_post", outcome: { response: { channel: "C0123", ts: "1.0", endsTurn: true } } },
  {
    id: "request-secret",
    tool: "request_secret",
    outcome: { response: { asked: "LINEAR_API_KEY", repo: "player.games-app" } },
  },
  {
    id: "list-secrets",
    tool: "list_secrets",
    outcome: { response: { repo: "player.games-app", set: [], missingForMcp: [] } },
  },
];

export const stubs = stubsFor("claude opus/high");

export type JobInput = {
  repo?: string;
  kind?: string;
  title?: string;
  brief?: string;
  harness?: string;
  model?: string;
  effort?: string;
};

export const asJob = (input: unknown) => (input ?? {}) as JobInput;
