import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcribe = vi.hoisted(() => vi.fn());
vi.mock("ai", () => ({ transcribe }));

const { default: transcribeAudio } = await import("../agent/tools/transcribe_audio.ts");

const CLIP = "/workspace/.eve/attachments/abc123/audio_message.m4a";
const bytes = new Uint8Array([1, 2, 3, 4]);

// A sandbox holding one file, recording what was read.
function context(files: Record<string, Uint8Array> = { [CLIP]: bytes }) {
  const reads: string[] = [];
  const ctx = {
    abortSignal: new AbortController().signal,
    getSandbox: async () => ({
      readBinaryFile: async ({ path }: { path: string }) => {
        reads.push(path);
        return files[path] ?? null;
      },
    }),
  };
  return { ctx: ctx as never, reads };
}

type Executable = { execute: (input: never, ctx: never) => unknown };
const run = (input: unknown, ctx: never) =>
  Promise.resolve((transcribeAudio as unknown as Executable).execute(input as never, ctx));

beforeEach(() => {
  transcribe.mockReset();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.KILN_TRANSCRIPTION_MODEL;
  vi.restoreAllMocks();
});

describe("transcribe_audio", () => {
  it("refuses paths outside the attachments folder, including traversal, without reading them", async () => {
    const { ctx, reads } = context();
    await expect(run({ path: "/workspace/secrets.env" }, ctx)).rejects.toThrow(/Only attachments/);
    await expect(run({ path: "/workspace/.eve/attachments/../../etc/passwd" }, ctx)).rejects.toThrow(
      /Only attachments/,
    );
    expect(reads).toEqual([]);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("asks for the clip again when the file is gone", async () => {
    const { ctx } = context({});
    await expect(run({ path: CLIP }, ctx)).rejects.toThrow(/send the voice note again/);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("turns a provider failure into an instruction to ask for text, and logs no words", async () => {
    transcribe.mockRejectedValue(new Error("unsupported audio format"));
    const { ctx } = context();
    await expect(run({ path: CLIP }, ctx)).rejects.toThrow(/unsupported audio format.*ask them to type it/);
    const logged = vi.mocked(console.error).mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(logged).toEqual([expect.objectContaining({ event: "audio.transcribe_failed", bytes: 4 })]);
  });

  it("transcribes the clip on the default model and logs size and timing, never the transcript", async () => {
    transcribe.mockResolvedValue({ text: "  can you add a dark mode toggle  " });
    const { ctx } = context();
    await expect(run({ path: CLIP }, ctx)).resolves.toEqual({ transcript: "can you add a dark mode toggle" });
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ model: "openai/gpt-4o-mini-transcribe", audio: bytes }),
    );
    const logs = vi.mocked(console.info).mock.calls.map((call) => String(call[0]));
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toMatch(/dark mode/);
    expect(JSON.parse(logs[0] ?? "")).toEqual(
      expect.objectContaining({ event: "audio.transcribed", bytes: 4, chars: 30 }),
    );
  });

  it("uses KILN_TRANSCRIPTION_MODEL when set", async () => {
    process.env.KILN_TRANSCRIPTION_MODEL = "openai/whisper-1";
    transcribe.mockResolvedValue({ text: "hi" });
    await run({ path: CLIP }, context().ctx);
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ model: "openai/whisper-1" }));
  });
});
