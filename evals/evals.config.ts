import { defineEvalConfig } from "eve/evals";

// Evals drive robdog's real model, so they spend tokens. Run them after
// changing instructions or tool descriptions, on more than one vendor:
//   ROBDOG_MODEL_URL=https://openrouter.ai/api/v1 ROBDOG_MODEL_KEY=... \
//   ROBDOG_MODEL=anthropic/claude-sonnet-5.5 pnpm eval
export default defineEvalConfig({
  maxConcurrency: 3,
  timeoutMs: 180_000,
});
