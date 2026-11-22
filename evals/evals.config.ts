import { defineEvalConfig } from "eve/evals";

// Evals drive the agent's real model through AI Gateway, so they spend tokens. `pnpm
// eval` gives the agent the example deployment in evals/deployment.json (KILN_CONFIG).
// Run them after changing the starter AGENTS.md or tool descriptions, on more than one
// vendor:
//   pnpm eval
//   KILN_MODEL=openai/gpt-6.2-sol pnpm eval
export default defineEvalConfig({
  maxConcurrency: 3,
  timeoutMs: 180_000,
});
