import { describe, expect, it, vi } from "vitest";
import { versionOf } from "../agent/lib/drive.ts";
import { starterAgentsMd } from "../lib/agents-starter.ts";
import { DEFAULT_AGENT_NAME } from "../lib/deployment.ts";
import {
  DriveConflict,
  DriveError,
  defaultFiles,
  driveName,
  drivePath,
  editFile,
  ensureDefaults,
  HISTORY_FOLDER,
  memoryDrive,
  moveFile,
  readText,
  removeFile,
  searchDrive,
  turnContext,
  writeFile,
} from "../lib/drive.ts";

const text = (s: string) => new TextEncoder().encode(s);

describe("paths", () => {
  it("cleans a path and refuses escapes, odd characters, and depth", () => {
    expect(drivePath("/thanksgiving/plan.md")).toBe("thanksgiving/plan.md");
    for (const bad of ["", "../x", "a/../b", "a//b", "a/b\\c", "a/$(x)", "1/2/3/4/5/6/7/8/9"]) {
      expect(() => drivePath(bad), bad).toThrow(DriveError);
    }
  });
});

describe("AGENTS.md", () => {
  it("starts as the whole starter prompt, with the agent's configured name, written once", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    expect(Object.keys(defaultFiles())).toEqual(["AGENTS.md"]);
    const starter = (await readText(store, "AGENTS.md")).text ?? "";
    expect(starter).toBe(starterAgentsMd());
    expect(starter).toContain(`You are ${DEFAULT_AGENT_NAME},`);
    expect(starterAgentsMd("Mabel")).toContain("You are Mabel,");
    for (const section of ["## How you talk", "## Jobs", "## What you can do", "## People", "## This file"]) {
      expect(starter, section).toContain(section);
    }
    expect(starter).not.toContain("INDEX.md");
    await writeFile(store, "AGENTS.md", text("# Who you are\n- Robert wants short answers."));
    await ensureDefaults(store);
    expect((await readText(store, "AGENTS.md")).text).toBe("# Who you are\n- Robert wants short answers.");
  });

  it("can be edited but never removed, moved, or renamed", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    await expect(removeFile(store, "AGENTS.md")).rejects.toThrow(/permanent/);
    await expect(moveFile(store, "AGENTS.md", "old/AGENTS.md")).rejects.toThrow(/permanent/);
    expect((await readText(store, "AGENTS.md")).text).toContain("# Who you are");
  });

  it("keeps the previous version in .history/ before every change, and only for AGENTS.md", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    expect(await store.list(HISTORY_FOLDER)).toEqual([]);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-11-22T05:00:00.000Z"));
      await writeFile(store, "AGENTS.md", text("v2"));
      vi.setSystemTime(new Date("2026-11-22T05:01:00.000Z"));
      await editFile(store, "AGENTS.md", "v3", "v2");
      await writeFile(store, "notes.md", text("a"));
      await writeFile(store, "notes.md", text("b"));
    } finally {
      vi.useRealTimers();
    }
    const history = await store.list(HISTORY_FOLDER);
    expect(history.map((entry) => entry.path)).toEqual([
      ".history/AGENTS-2026-11-22T05-00-00-000Z.md",
      ".history/AGENTS-2026-11-22T05-01-00-000Z.md",
    ]);
    expect((await readText(store, history[0]?.path ?? "")).text).toBe(starterAgentsMd());
    expect((await readText(store, history[1]?.path ?? "")).text).toBe("v2");
    expect((await readText(store, "AGENTS.md")).text).toBe("v3");
  });

  it("is the agent's prompt as written, cut past 24,000 characters, and empty when blank", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    await writeFile(store, "xmas/plan.md", text("the snow theme"));
    expect(await turnContext(store)).toBe(starterAgentsMd().trim());
    await writeFile(store, "AGENTS.md", text(`# Who you are\n${"x".repeat(23_900)}`));
    expect(await turnContext(store)).not.toContain("[cut:");
    await writeFile(store, "AGENTS.md", text(`# Who you are\n${"x".repeat(24_100)}`));
    expect(await turnContext(store)).toContain("[cut: AGENTS.md is too long; tighten it]");
    await writeFile(store, "AGENTS.md", text("  \n"));
    expect(await turnContext(store)).toBe("");
  });
});

describe("driveName", () => {
  it("makes any file name safe for the drive, keeping its extension", () => {
    expect(driveName("Screen Shot 2026-11-22 at 9.41.03 AM.png")).toBe(
      "Screen Shot 2026-11-22 at 9.41.03 AM.png",
    );
    expect(driveName("logo@2x.png")).toBe("logo-2x.png");
    expect(driveName("../../etc/passwd")).toBe("passwd");
    expect(driveName("..")).toBe("file");
    expect(driveName("")).toBe("file");
    expect(driveName(`${"a".repeat(150)}.zip`)).toHaveLength(100);
    expect(driveName(`${"a".repeat(150)}.zip`).endsWith(".zip")).toBe(true);
    expect(() => drivePath(`jobs/msg_1/${driveName("we!rd$name#.json")}`)).not.toThrow();
  });
});

describe("editFile", () => {
  it("applies two edits of one file made at the same moment, instead of the last write dropping the first", async () => {
    const store = memoryDrive();
    await writeFile(store, "notes.md", new TextEncoder().encode("one\ntwo\n"));
    await Promise.all([editFile(store, "notes.md", "ONE", "one"), editFile(store, "notes.md", "TWO", "two")]);
    expect((await readText(store, "notes.md")).text).toBe("ONE\nTWO\n");
  });

  it("compares Blob's strong ETag, which a compressed read reports in its weak form", () => {
    // AGENTS.md read back as W/"..." and no conditional write of it ever matched.
    expect(versionOf('W/"6e5f7070b94d75faf1ba46a2eacfa518"')).toBe('"6e5f7070b94d75faf1ba46a2eacfa518"');
    expect(versionOf('"deed54b823522e0525693b090363f9df"')).toBe('"deed54b823522e0525693b090363f9df"');
  });

  it("gives up with the conflict when the file keeps changing under it", async () => {
    const store = memoryDrive();
    await writeFile(store, "notes.md", new TextEncoder().encode("one\n"));
    const write = vi
      .spyOn(store, "write")
      .mockRejectedValue(new DriveConflict("notes.md changed since it was read"));
    await expect(editFile(store, "notes.md", "ONE", "one")).rejects.toBeInstanceOf(DriveConflict);
    expect(write).toHaveBeenCalledTimes(5);
  });

  it("refuses text it can't place exactly, and binary files, changing nothing", async () => {
    const store = memoryDrive();
    await writeFile(store, "AGENTS.md", text("- a\n- b\n- a\n"));
    await expect(editFile(store, "AGENTS.md", "- c", "- z")).rejects.toThrow(/not in AGENTS.md/);
    await expect(editFile(store, "AGENTS.md", "- c", "- a")).rejects.toThrow(/occurs 2 times/);
    await expect(editFile(store, "missing.md", "- c", "- a")).rejects.toThrow(/no file/);
    await expect(editFile(store, "hero.png", "x")).rejects.toThrow(/not a text file/);
    expect((await readText(store, "AGENTS.md")).text).toBe("- a\n- b\n- a\n");
  });

  it("replaces one exact occurrence, deletes with an empty replacement, and keeps $ literal", async () => {
    const store = memoryDrive();
    await writeFile(store, "AGENTS.md", text("- Robert: Pacific\n- PRs: link them\n"));
    await editFile(store, "AGENTS.md", "- Robert: Eastern, costs in $&", "- Robert: Pacific");
    await editFile(store, "AGENTS.md", "", "- PRs: link them\n");
    expect((await readText(store, "AGENTS.md")).text).toBe("- Robert: Eastern, costs in $&\n");
  });

  it("appends a line, adding a newline where the file lacks one, and creates the file", async () => {
    const store = memoryDrive();
    await writeFile(store, "AGENTS.md", text("# Who I am"));
    await editFile(store, "AGENTS.md", "- no em dashes");
    await editFile(store, "AGENTS.md", "- hyperlink PRs");
    expect((await readText(store, "AGENTS.md")).text).toBe("# Who I am\n- no em dashes\n- hyperlink PRs\n");
    expect(await editFile(store, "notes/new.md", "first")).toEqual({ path: "notes/new.md", size: 6 });
  });
});

describe("everything else", () => {
  it("is an empty canvas: any folders, any files, moved and removed freely", async () => {
    const store = memoryDrive();
    await writeFile(store, "thanksgiving/research/competitors.md", text("notes"));
    await writeFile(store, "thanksgiving/assets/hero.png", new Uint8Array([0x89, 0x50]));
    await writeFile(store, "people.md", text("Robert: Eastern time"));
    expect(await readText(store, "thanksgiving/assets/hero.png")).toEqual({
      path: "thanksgiving/assets/hero.png",
      contentType: "image/png",
      size: 2,
    });
    expect(await moveFile(store, "people.md", "team/people.md")).toBe("team/people.md");
    expect(await removeFile(store, "thanksgiving/research/competitors.md")).toBe(
      "thanksgiving/research/competitors.md",
    );
    expect((await store.list("")).map((e) => e.path)).toEqual([
      "team/people.md",
      "thanksgiving/assets/hero.png",
    ]);
  });

  it("is searchable, case-insensitively, within a folder", async () => {
    const store = memoryDrive();
    await writeFile(store, "xmas/decisions.md", text("2026-11-20: Ship SNOW behind a flag"));
    await writeFile(store, "xmas/plan.md", text("# Plan\nsnow first"));
    await writeFile(store, "analytics/notes.md", text("snow!"));
    const hits = await searchDrive(store, "snow", "xmas");
    expect(hits.map((h) => h.path)).toEqual(["xmas/decisions.md", "xmas/plan.md"]);
    expect(hits[0]).toEqual({
      path: "xmas/decisions.md",
      line: 1,
      text: "2026-11-20: Ship SNOW behind a flag",
    });
  });
});
