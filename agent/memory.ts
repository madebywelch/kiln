import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { agent } from "../lib/config.ts";

// One memory for the agent, shared by every channel, DM, and person it talks to:
// it is one teammate with one mind. Scope this per person or per channel only
// when you want isolation.
export default defineMemory({
  description:
    `Durable facts ${agent.name} keeps across every conversation: people's preferences, decisions made, ` +
    "what each repo and project is, ideas worth returning to, and pointers (job numbers, PR links) rather than copies.",
  provider: fileMemory({ maxCharacters: 8_000 }),
  // The scope is the namespace of the memory: renaming the agent starts a new one.
  scope: agent.name,
});
