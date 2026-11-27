import { defineEvalConfig } from "eve/evals";
import { inferenceFrom } from "../lib/inference.ts";

// Evals drive the agent's real model on the deployment's inference endpoint, never AI
// Gateway: `pnpm eval` clears the Gateway credentials, so nothing can fall back to it,
// and refuses to start without INFERENCE_BASE_URL and INFERENCE_API_KEY (set them in
// .env.local, which eve loads). KILN_MODEL picks the endpoint's model (default
// claude-fable-5-2). `pnpm eval` gives the agent the example deployment in
// evals/deployment.json (KILN_CONFIG). Run them after changing the starter AGENTS.md
// or tool descriptions:
//   pnpm eval
//   KILN_MODEL=<another model the endpoint serves> pnpm eval
const inference = inferenceFrom(process.env);
const problem =
  inference === undefined
    ? "pnpm eval runs on the inference endpoint only: set INFERENCE_BASE_URL and INFERENCE_API_KEY in .env.local"
    : typeof inference === "string"
      ? `pnpm eval: ${inference}`
      : undefined;
if (problem) {
  // eve reports only that the config failed to load, so say why here.
  console.error(problem);
  throw new Error(problem);
}

export default defineEvalConfig({
  maxConcurrency: 3,
  timeoutMs: 180_000,
});
