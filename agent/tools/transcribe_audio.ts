import { posix } from "node:path";
import { transcribe } from "ai";
import { defineTool } from "eve/tools";
import { z } from "zod";

// An AI Gateway transcription model. Transcription always goes through AI
// Gateway, even when KILN_MODEL_URL points the agent's own model elsewhere.
const DEFAULT_MODEL = "openai/gpt-4o-mini-transcribe";
// Where eve saves inbound files. The tool reads nothing else.
const ATTACHMENTS_DIR = "/workspace/.eve/attachments/";

export default defineTool({
  description:
    "Transcribe an audio attachment, such as a Slack voice clip, to text. Pass the path from its `Attached file` label.",
  inputSchema: z.object({
    path: z.string().describe(`The attachment's path, under ${ATTACHMENTS_DIR}`),
  }),
  outputSchema: z.object({ transcript: z.string() }),
  label: { start: () => "Listen to the voice note" },
  async execute({ path }, ctx) {
    const file = posix.normalize(path);
    if (!file.startsWith(ATTACHMENTS_DIR)) {
      throw new Error(`Only attachments under ${ATTACHMENTS_DIR} can be transcribed.`);
    }
    const sandbox = await ctx.getSandbox();
    const audio = await sandbox.readBinaryFile({ path: file, signal: ctx.abortSignal });
    if (!audio) throw new Error(`No attachment at ${file}. Ask them to send the voice note again.`);

    const model = process.env.KILN_TRANSCRIPTION_MODEL || DEFAULT_MODEL;
    const started = Date.now();
    try {
      const { text } = await transcribe({ model, audio, abortSignal: ctx.abortSignal });
      const transcript = text.trim();
      // Size and timing only, never the words.
      console.info(
        JSON.stringify({
          event: "audio.transcribed",
          model,
          bytes: audio.byteLength,
          ms: Date.now() - started,
          chars: transcript.length,
        }),
      );
      return { transcript };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ event: "audio.transcribe_failed", model, bytes: audio.byteLength, error: reason }),
      );
      throw new Error(
        `Transcription failed (${reason}). Tell them you couldn't make out the voice note and ask them to type it.`,
      );
    }
  },
});
