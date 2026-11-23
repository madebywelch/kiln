import { beforeAll, describe, expect, it } from "vitest";
import { drive } from "../agent/lib/drive.ts";
import driveRead from "../agent/tools/drive_read.ts";
import { writeFile } from "../lib/drive.ts";

type Tool = {
  execute: (input: never, ctx: never) => unknown;
  toModelOutput: (output: never) => unknown;
};
const tool = driveRead as unknown as Tool;
const read = async (path: string) => {
  const output = await tool.execute({ path } as never, {} as never);
  return { output, model: tool.toModelOutput(output as never) };
};

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  // The in-memory drive: no Blob store in tests.
  delete process.env.EVE_MEMORY_BLOB_STORE_ID;
  const store = await drive();
  await writeFile(store, "jobs/b906a40d/page.png", PNG);
  await writeFile(store, "jobs/b906a40d/huge.png", new Uint8Array(3 * 1024 * 1024 + 1));
  await writeFile(store, "notes.md", new TextEncoder().encode("hello\n"));
});

describe("drive_read", () => {
  it("shows the model an image a worker returned", async () => {
    const { model } = await read("jobs/b906a40d/page.png");
    expect(model).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: JSON.stringify({ path: "jobs/b906a40d/page.png", contentType: "image/png", size: 8 }),
        },
        {
          type: "file",
          mediaType: "image/png",
          data: { type: "data", data: Buffer.from(PNG).toString("base64") },
        },
      ],
    });
  });

  it("says an image is too large to view instead of sending it", async () => {
    const { output, model } = await read("jobs/b906a40d/huge.png");
    expect(output).toMatchObject({ note: expect.stringMatching(/too large/) });
    expect(output).not.toHaveProperty("image");
    expect(model).toMatchObject({ type: "json" });
  });

  it("still reads text as text", async () => {
    const { output } = await read("notes.md");
    expect(output).toMatchObject({ path: "notes.md", text: "hello\n" });
  });
});
