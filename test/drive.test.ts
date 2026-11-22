import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILES,
  DriveError,
  drivePath,
  ensureDefaults,
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

describe("the default files", () => {
  it("are there from the start, written once", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    expect(Object.keys(DEFAULT_FILES)).toEqual(["AGENTS.md", "INDEX.md"]);
    expect(DEFAULT_FILES["AGENTS.md"]).toContain("INDEX.md is my map");
    await writeFile(store, "INDEX.md", text("# Index\n- thanksgiving/: the banner"));
    await ensureDefaults(store);
    expect((await readText(store, "INDEX.md")).text).toBe("# Index\n- thanksgiving/: the banner");
  });

  it("can be edited but never removed, moved, or renamed", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    await writeFile(store, "AGENTS.md", text("# How I work\n- Robert wants short answers."));
    await expect(removeFile(store, "AGENTS.md")).rejects.toThrow(/permanent/);
    await expect(moveFile(store, "INDEX.md", "old/INDEX.md")).rejects.toThrow(/permanent/);
    expect((await readText(store, "AGENTS.md")).text).toContain("short answers");
  });

  it("shows the agent AGENTS.md every turn, not INDEX.md, which changes too often for the prompt cache", async () => {
    const store = memoryDrive();
    await ensureDefaults(store);
    await writeFile(store, "INDEX.md", text("# Index\n- xmas/: the snow theme"));
    const context = await turnContext(store);
    expect(context).toContain("[your drive's AGENTS.md, from kiln]\n# How I work");
    expect(context).not.toContain("xmas/");
    await writeFile(store, "AGENTS.md", text(`# How I work\n${"x".repeat(7_000)}`));
    expect(await turnContext(store)).toContain("[cut: AGENTS.md is too long; tighten it]");
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
