// Installs the repo's worker skills into each coding CLI's skill folder when
// the worker starts. The home directory persists, so this runs every start:
// skills added or changed in the repo arrive, removed ones go, and skills a
// person installed by hand are left alone.

import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Marks a skill folder as installed from the repo, so a later start may replace or remove it. */
const MARKER = ".kiln-managed";

/** Claude Code and OpenCode read ~/.claude/skills; Codex reads ~/.codex/skills. */
export function skillTargets(home: string): string[] {
  return [join(home, ".claude", "skills"), join(home, ".codex", "skills")];
}

async function dirs(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export interface SkillSync {
  readonly installed: string[];
  readonly removed: string[];
  readonly kept: string[];
}

export async function installSkills(source: string, targets: readonly string[]): Promise<SkillSync> {
  const wanted = await dirs(source);
  const result: SkillSync = { installed: [], removed: [], kept: [] };
  for (const target of targets) {
    await mkdir(target, { recursive: true });
    for (const name of await dirs(target)) {
      if (wanted.includes(name)) continue;
      if (await exists(join(target, name, MARKER))) {
        await rm(join(target, name), { recursive: true, force: true });
        result.removed.push(join(target, name));
      } else {
        result.kept.push(join(target, name));
      }
    }
    for (const name of wanted) {
      const destination = join(target, name);
      await rm(destination, { recursive: true, force: true });
      await cp(join(source, name), destination, { recursive: true });
      await writeFile(
        join(destination, MARKER),
        "Installed from the kiln repo's skills/workers. Edit it there.\n",
      );
      result.installed.push(destination);
    }
  }
  return result;
}
