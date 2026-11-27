import type { ToolStub } from "eve/evals";

// Tools that reach Slack or the board return canned results in evals, so a run
// touches nothing real and the assertions see exactly what the agent asked for.
// Every tool that leaves the process is stubbed here; keep it that way.

/** `runsOn` is what the pool reports back; give it the selection the eval expects the agent to ask for. */
export const stubsFor = (runsOn: string): ToolStub[] => [
  {
    id: "start-job",
    tool: "start_job",
    outcome: {
      response: { job: "#b799fe5c", state: "ready", runsOn, secrets: "none", reportsTo: "this thread" },
    },
  },
  { id: "list-jobs", tool: "list_jobs", outcome: { response: { jobs: [] } } },
  {
    id: "job-details",
    tool: "job_details",
    outcome: { response: { job: "#b799fe5c", state: "ready", title: "the job", log: [] } },
  },
  { id: "cancel-job", tool: "cancel_job", outcome: { response: { job: "#b799fe5c", state: "canceled" } } },
  { id: "answer-job", tool: "answer_job", outcome: { response: { job: "#b799fe5c", state: "ready" } } },
  {
    id: "retry-job",
    tool: "retry_job",
    outcome: { response: { job: "#b799fe5c", state: "ready", runsOn, continues: "from the start" } },
  },
  {
    id: "prioritize-job",
    tool: "prioritize_job",
    outcome: { response: { job: "#b799fe5c", state: "ready", priority: true } },
  },
  { id: "wish", tool: "wish", outcome: { response: { wish: "#1a2b3c4d", summary: "x", state: "ready" } } },
  { id: "list-wishes", tool: "list_wishes", outcome: { response: { wishes: [] } } },
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
    outcome: { response: { asked: "LINEAR_API_KEY", repo: "web", group: "staging" } },
  },
  {
    id: "copy-secrets-to-github",
    tool: "copy_secrets_to_github",
    outcome: {
      response: {
        offered: ["PROD_WRITE_FLY_API_TOKEN as FLY_API_TOKEN"],
        to: "acme/web environment production",
      },
    },
  },
  {
    id: "delete-secret",
    tool: "delete_secret",
    outcome: { response: { offered: "HELLO_WORLD", repo: "web", group: "staging" } },
  },
  { id: "drive-list", tool: "drive_list", outcome: { response: { files: [] } } },
  { id: "list-tasks", tool: "list_tasks", outcome: { response: { pending: [] } } },
  {
    id: "drive-read",
    tool: "drive_read",
    outcome: { response: { path: "x", contentType: "text/markdown", size: 0, text: "" } },
  },
  { id: "drive-write", tool: "drive_write", outcome: { response: { saved: "x", bytes: 1 } } },
  { id: "drive-edit", tool: "drive_edit", outcome: { response: { path: "AGENTS.md", size: 1 } } },
  { id: "drive-move", tool: "drive_move", outcome: { response: { removed: "x" } } },
  { id: "drive-search", tool: "drive_search", outcome: { response: { hits: [] } } },
  { id: "drive-share", tool: "drive_share", outcome: { response: { shared: "x", bytes: 1 } } },
  {
    id: "transcribe",
    tool: "transcribe_audio",
    outcome: { response: { transcript: "Can you add a dark mode toggle to the website?" } },
  },
  {
    id: "list-secrets",
    tool: "list_secrets",
    outcome: {
      response: {
        repo: "web",
        groups: { staging: [], "production-read": [], "production-write": [] },
        mcpServers: {},
      },
    },
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
  files?: string[];
  pull_request?: number;
};

export const asJob = (input: unknown) => (input ?? {}) as JobInput;
