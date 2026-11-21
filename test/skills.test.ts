import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installSkills, skillTargets } from "../worker/skills.ts";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "robdog-skills-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function skill(dir: string, name: string, body: string) {
  await mkdir(join(dir, name), { recursive: true });
  await writeFile(join(dir, name, "SKILL.md"), body);
}

it("installs the repo's skills for every CLI, replaces changed ones, drops removed ones, and keeps hand-installed ones", async () => {
  const source = join(root, "repo-skills");
  const targets = skillTargets(join(root, "home"));
  await skill(source, "ui-taste", "v1");
  await skill(source, "old", "old");
  await skill(targets[0]!, "mine", "hand-installed");

  await installSkills(source, targets);
  for (const target of targets) {
    expect(await readFile(join(target, "ui-taste", "SKILL.md"), "utf8")).toBe("v1");
  }

  await rm(join(source, "old"), { recursive: true });
  await skill(source, "ui-taste", "v2");
  const second = await installSkills(source, targets);

  expect((await readdir(targets[0]!)).sort()).toEqual(["mine", "ui-taste"]);
  expect((await readdir(targets[1]!)).sort()).toEqual(["ui-taste"]);
  expect(await readFile(join(targets[1]!, "ui-taste", "SKILL.md"), "utf8")).toBe("v2");
  expect(second.removed).toHaveLength(2);
  expect(second.kept).toEqual([join(targets[0]!, "mine")]);
});

it("works with no skills to install", async () => {
  const result = await installSkills(join(root, "nothing"), skillTargets(join(root, "home")));
  expect(result.installed).toEqual([]);
});
