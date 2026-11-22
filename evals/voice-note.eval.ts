import { resolve } from "node:path";
import { defineEval } from "eve/evals";
import { stubs } from "./stubs.ts";

// Evals are bundled before they run, so resolve from the repo root, where `pnpm eval` runs.
const CLIP = resolve("evals/fixtures/voice-note.m4a");

export default defineEval({
  description:
    "A voice note is heard before it is answered: the agent transcribes it, then treats it as typed.",
  async test(t) {
    const session = await t.session({
      stubs: [
        ...stubs.filter((stub) => stub.tool !== "transcribe_audio"),
        {
          id: "transcribe",
          tool: "transcribe_audio",
          outcome: {
            response: {
              transcript:
                "Is a christmas theme for the website worth doing, or is it gimmicky? Give me your honest take.",
            },
          },
        },
      ],
    });
    // A Slack voice clip has no text; the eval channel needs some, so it carries none of the meaning.
    const turn = await session.sendFile("[voice clip]", CLIP, "audio/mp4");
    turn.expectOk();
    turn.calledTool("transcribe_audio", { count: 1 });
    turn.notCalledTool("start_job");
    turn.notCalledTool("no_reply");
    turn.messageIncludes(/christmas|theme|gimmick/i);
  },
});
