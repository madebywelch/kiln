// Traces for every turn, with their content: the prompt and context the model
// saw, its replies and reasoning, and each tool call's input and result. They go
// to Vercel Agent Runs (the project's Observability tab), kept 30 days.
//
// eve's default records content only for public Slack channels; DMs and private
// channels would show timing alone. kiln records it everywhere, so any turn can
// be inspected. Narrow this if the workspace is shared with people who should
// not have their DMs in traces.
import { otel } from "eve/instrumentation/otel";

export default otel({
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
  tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
});
