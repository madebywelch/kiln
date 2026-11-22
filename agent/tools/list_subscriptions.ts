import { defineTool } from "eve/tools";
import { z } from "zod";
import { claudeSubscriptions, readLedger } from "../../lib/accounts.ts";
import { team } from "../lib/board.ts";

const iso = (seconds: number) => new Date(seconds * 1000).toISOString();

export default defineTool({
  description:
    "Show the Claude subscriptions jobs run on: how much of each usage window was used when a job last ran on it, " +
    "when each window resets, and which are out of usage, for every model or for one. Use it when someone asks " +
    "about usage, limits, or why a job is waiting.",
  inputSchema: z.object({}),
  label: false,
  async execute() {
    const names = claudeSubscriptions(process.env).map((s) => s.id);
    const states = await readLedger(team, "claude");
    const now = Date.now() / 1000;
    return {
      fillOrder: names,
      subscriptions: names.map((name) => {
        const state = states.get(name);
        return {
          name,
          windows: Object.fromEntries(
            Object.entries(state?.usage ?? {}).map(([window, use]) => [
              window,
              { used: `${use.percent}%`, resetsAt: use.resetsAt ? iso(use.resetsAt) : null },
            ]),
          ),
          outOfUsage: Object.fromEntries(
            Object.entries(state?.benches ?? {})
              .filter(([, until]) => until > now)
              .map(([scope, until]) => [scope === "all" ? "every model" : scope, `until ${iso(until)}`]),
          ),
        };
      }),
    };
  },
});
