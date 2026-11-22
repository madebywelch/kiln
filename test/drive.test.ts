import { describe, expect, it } from "vitest";
import {
  DriveError,
  drivePath,
  ensureReadme,
  indexText,
  memoryDrive,
  moveFile,
  projectFront,
  projectIndex,
  readText,
  removeFile,
  searchDrive,
  writeFile,
} from "../lib/drive.ts";

const text = (s: string) => new TextEncoder().encode(s);
const project = (summary: string, status = "active") =>
  `---\nsummary: ${summary}\nstatus: ${status}\n---\n\n# Goal\n`;

describe("paths", () => {
  it("cleans a path and refuses escapes, odd characters, and depth", () => {
    expect(drivePath("/projects/thanksgiving/plan.md")).toBe("projects/thanksgiving/plan.md");
    for (const bad of ["", "../x", "a/../b", "a//b", "a/b\\c", "a/$(x)", "1/2/3/4/5/6/7/8/9"]) {
      expect(() => drivePath(bad), bad).toThrow(DriveError);
    }
  });
});

describe("the drive's rules", () => {
  it("writes its own README once, and never lets it be changed or removed", async () => {
    const store = memoryDrive();
    await ensureReadme(store);
    expect((await readText(store, "README.md")).text).toContain("One folder per project");
    await expect(writeFile(store, "README.md", text("mine"))).rejects.toThrow(/kiln's/);
    await expect(removeFile(store, "README.md")).rejects.toThrow(/kiln's/);
    await expect(moveFile(store, "README.md", "x.md")).rejects.toThrow(/kiln's/);
  });

  it("refuses a PROJECT.md without its summary and status, and files loose in projects/", async () => {
    const store = memoryDrive();
    await expect(writeFile(store, "projects/xmas/PROJECT.md", text("# Christmas"))).rejects.toThrow(
      /frontmatter/,
    );
    await expect(
      writeFile(store, "projects/xmas/PROJECT.md", text(project("Snow", "someday"))),
    ).rejects.toThrow(/status/);
    await expect(writeFile(store, "projects/notes.md", text("x"))).rejects.toThrow(/inside its folder/);
    expect(await writeFile(store, "projects/xmas/PROJECT.md", text(project("Snow on the site")))).toBe(
      "projects/xmas/PROJECT.md",
    );
  });

  it("leaves everything else to the agent: any folders, any files", async () => {
    const store = memoryDrive();
    await writeFile(store, "projects/xmas/research/competitors.md", text("notes"));
    await writeFile(store, "projects/xmas/assets/hero.png", new Uint8Array([0x89, 0x50]));
    await writeFile(store, "people.md", text("Robert: Eastern time"));
    expect(await readText(store, "projects/xmas/assets/hero.png")).toEqual({
      path: "projects/xmas/assets/hero.png",
      contentType: "image/png",
      size: 2,
    });
  });

  it("moves a file, checking the rules at its new path", async () => {
    const store = memoryDrive();
    await writeFile(store, "draft.md", text("# not a project file"));
    await expect(moveFile(store, "draft.md", "projects/xmas/PROJECT.md")).rejects.toThrow(/frontmatter/);
    expect(await moveFile(store, "draft.md", "archive/draft.md")).toBe("archive/draft.md");
    await expect(readText(store, "draft.md")).rejects.toThrow(/no file/);
  });
});

describe("projectIndex", () => {
  it("lists each project with its summary and status, most recently touched first, and flags a missing PROJECT.md", async () => {
    let clock = 0;
    const store = memoryDrive(() => new Date(Date.UTC(2026, 10, 21, 0, clock++)).toISOString());
    await writeFile(store, "projects/thanksgiving/PROJECT.md", text(project("Turkey banner live", "done")));
    await writeFile(store, "projects/analytics/notes.md", text("x"));
    await writeFile(store, "projects/xmas/PROJECT.md", text(project("Snow theme, in review")));
    const projects = await projectIndex(store);
    expect(projects.map((p) => [p.slug, p.status, p.summary])).toEqual([
      ["xmas", "active", "Snow theme, in review"],
      ["analytics", "active", "(PROJECT.md is missing)"],
      ["thanksgiving", "done", "Turkey banner live"],
    ]);
    expect(indexText(projects)).toContain(
      "- xmas (active, 1 files, updated 2026-11-21): Snow theme, in review",
    );
    expect(indexText([])).toContain("No projects yet");
  });
});

describe("searchDrive", () => {
  it("finds a phrase in text files, case-insensitively, within a folder", async () => {
    const store = memoryDrive();
    await writeFile(store, "projects/xmas/PROJECT.md", text(project("Snow theme")));
    await writeFile(store, "projects/xmas/decisions.md", text("2026-11-20: Ship SNOW behind a flag"));
    await writeFile(store, "projects/analytics/notes.md", text("no snow here? snow!"));
    const hits = await searchDrive(store, "snow", "projects/xmas");
    expect(hits.map((h) => h.path)).toEqual(["projects/xmas/decisions.md", "projects/xmas/PROJECT.md"]);
    expect(hits[0]).toEqual({
      path: "projects/xmas/decisions.md",
      line: 1,
      text: "2026-11-20: Ship SNOW behind a flag",
    });
  });

  it("reads frontmatter loosely: quotes and trailing comments", () => {
    expect(projectFront('---\nsummary: "Snow"\nstatus: paused   # until December\n---')).toEqual({
      summary: "Snow",
      status: "paused",
    });
  });
});
