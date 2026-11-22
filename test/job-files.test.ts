import { describe, expect, it } from "vitest";
import { collectJobFiles, type FileSources, JobFileError } from "../lib/job-files.ts";
import { MAX_JOB_FILE_BYTES, MAX_JOB_FILES } from "../lib/jobs.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

// A sandbox and a drive holding a few files, recording every read.
function sources(sandbox: Record<string, Uint8Array> = {}, drive: Record<string, Uint8Array> = {}) {
  const reads: string[] = [];
  const from: FileSources = {
    sandbox: async (path) => {
      reads.push(`sandbox:${path}`);
      return sandbox[path] ?? null;
    },
    drive: async (path) => {
      reads.push(`drive:${path}`);
      return drive[path] ?? null;
    },
  };
  return { from, reads };
}

describe("collectJobFiles", () => {
  it("refuses sandbox paths outside /workspace/, traversal included, without reading", async () => {
    const { from, reads } = sources();
    for (const path of ["/etc/passwd", "/workspace/../etc/passwd"]) {
      await expect(collectJobFiles([path], from), path).rejects.toThrow(/must be under \/workspace\//);
    }
    expect(reads).toEqual([]);
  });

  it("refuses too many files, a missing or empty one, and one over the limit", async () => {
    const { from } = sources(
      { "/workspace/empty.txt": bytes(), "/workspace/huge.zip": new Uint8Array(MAX_JOB_FILE_BYTES + 1) },
      {},
    );
    const many = Array.from({ length: MAX_JOB_FILES + 1 }, (_, index) => `f${index}.txt`);
    await expect(collectJobFiles(many, from)).rejects.toThrow(`at most ${MAX_JOB_FILES} files`);
    await expect(collectJobFiles(["assets/missing.png"], from)).rejects.toThrow(
      "no file at assets/missing.png",
    );
    await expect(collectJobFiles(["/workspace/empty.txt"], from)).rejects.toThrow("is empty");
    await expect(collectJobFiles(["/workspace/huge.zip"], from)).rejects.toThrow("is over 25 MB");
  });

  it("refuses two files the worker would see under one name", async () => {
    const { from } = sources(
      { "/workspace/.eve/attachments/a1/logo.png": bytes(1) },
      { "brand/logo.png": bytes(2) },
    );
    await expect(
      collectJobFiles(["/workspace/.eve/attachments/a1/logo.png", "brand/logo.png"], from),
    ).rejects.toThrow(JobFileError);
  });

  it("reads Slack attachments from the sandbox and the rest from the drive, named by basename", async () => {
    const { from, reads } = sources(
      { "/workspace/.eve/attachments/a1/favicon.ico": bytes(0, 0, 1, 0) },
      { "guaca/data.bin": bytes(255) },
    );
    const files = await collectJobFiles(
      ["/workspace/.eve/attachments/a1/favicon.ico", " guaca/data.bin "],
      from,
    );
    expect(files.map((file) => [file.name, [...file.bytes]])).toEqual([
      ["favicon.ico", [0, 0, 1, 0]],
      ["data.bin", [255]],
    ]);
    expect(reads).toEqual(["sandbox:/workspace/.eve/attachments/a1/favicon.ico", "drive:guaca/data.bin"]);
    expect(await collectJobFiles([], from)).toEqual([]);
  });
});
