import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";

// One memory for robdog, shared by every channel, DM, and person it talks to:
// it is one teammate with one mind. Scope this per person or per channel only
// when you want isolation.
export default defineMemory({
  description:
    "Durable facts robdog keeps across every conversation: people's preferences, decisions made, what each repo " +
    "and project is, ideas worth returning to, and pointers (job numbers, PR links) rather than copies.",
  provider: fileMemory({ maxCharacters: 8_000 }),
  scope: "robdog",
});
