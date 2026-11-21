import { defineEvalConfig } from "eve/evals";

// Evals drive the agent's real model, so they spend tokens. Run them after
// changing instructions or tool descriptions, on more than one vendor:
//   KILN_MODEL_URL=https://openrouter.ai/api/v1 KILN_MODEL_KEY=... \
//   KILN_MODEL=anthropic/claude-sonnet-5.5 pnpm eval
export default defineEvalConfig({
  maxConcurrency: 3,
  timeoutMs: 180_000,
});
