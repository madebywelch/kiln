// The agent's drive: a folder of files it organizes itself, so it can keep many
// initiatives straight. kiln owns two things in it: README.md, which explains
// the drive to the agent, and the rule that every project folder has a
// PROJECT.md. Everything else is the agent's to arrange: notes, plans,
// decisions, research, assets. The agent sees the project index on every turn
// and opens a project's files when the conversation is about it.

import { agent } from "./config.ts";

export interface DriveEntry {
  readonly path: string;
  readonly size: number;
  readonly updatedAt: string;
}

/** Where the files live. Blob in production; a map in tests. Paths are relative to the drive's root. */
export interface DriveStore {
  list(prefix: string): Promise<DriveEntry[]>;
  read(path: string): Promise<{ readonly bytes: Uint8Array; readonly contentType: string } | null>;
  write(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export class DriveError extends Error {
  override readonly name = "DriveError";
}

export const README = "README.md";
export const PROJECT_FILE = "PROJECT.md";
export const PROJECTS = "projects";
export const STATUSES = ["active", "paused", "done"] as const;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_READ = 100_000;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_HITS = 40;

const TEXT_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
  yaml: "text/yaml; charset=utf-8",
  yml: "text/yaml; charset=utf-8",
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
};
const BINARY_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  mp4: "video/mp4",
  zip: "application/zip",
};

const extension = (path: string) => path.split(".").at(-1)?.toLowerCase() ?? "";
export const isText = (path: string) => extension(path) in TEXT_TYPES;
export const contentTypeOf = (path: string) =>
  TEXT_TYPES[extension(path)] ?? BINARY_TYPES[extension(path)] ?? "application/octet-stream";

/** A clean relative path: no leading slash, no `.` or `..`, ordinary characters, not too deep. */
export function drivePath(raw: string): string {
  const path = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  const segments = path.split("/");
  if (!path || segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new DriveError(`"${raw}" is not a file path in the drive`);
  }
  if (segments.some((s) => !/^[\w.() -]{1,100}$/.test(s))) {
    throw new DriveError(`"${raw}": use letters, digits, spaces, and . _ - ( ) in names`);
  }
  if (segments.length > 8) throw new DriveError(`"${raw}" is nested too deep; keep it within 8 folders`);
  return path;
}

/** A folder prefix for listing: "" for the root, else a clean path with a trailing slash. */
export function driveFolder(raw: string | undefined): string {
  if (!raw?.trim() || raw.trim() === "/") return "";
  return `${drivePath(raw)}/`;
}

export const README_TEXT = `# ${agent.name}'s drive

This drive is yours. Use it to keep track of everything people are working on, so nothing depends on one Slack thread.

## What kiln asks of you

- **One folder per project:** \`projects/<slug>/\`, where a project is an initiative people talk about ("thanksgiving", "analytics"), not necessarily a repo. A project can touch several repos; a repo can serve several projects.
- **Every project folder has a PROJECT.md**, starting with this frontmatter:

  \`\`\`
  ---
  summary: One line on what it is and where it stands.
  status: active        # active, paused, or done
  ---
  \`\`\`

  Below it: the goal, who cares about it, links to its Slack threads, jobs, and pull requests, decisions with dates, and open questions. Keep it current: it is what you read first when the project comes up.

## Everything else is yours to arrange

Notes, plans, research, meeting summaries, specs, checklists, screenshots, and other assets, in whatever folders make sense. Some habits that help:

- Update a file rather than writing a new one that says nearly the same thing.
- Date what you add, so later you can tell what is current.
- Link files to each other and to Slack threads, jobs, and PRs instead of copying them.
- Knowledge that spans projects (people, conventions, a glossary) can live at the root.
- Move or remove what is stale. A smaller, accurate drive beats a large, stale one.

This README is kiln's; you can't change it.
`;

/** Writes README.md if it is missing, so the drive explains itself. */
export async function ensureReadme(store: DriveStore): Promise<void> {
  if (!(await store.read(README))) {
    await store.write(README, new TextEncoder().encode(README_TEXT), contentTypeOf(README));
  }
}

export interface ProjectFront {
  readonly summary: string;
  readonly status: (typeof STATUSES)[number];
}

/** Reads PROJECT.md's frontmatter, or says what is wrong with it. */
export function projectFront(text: string): ProjectFront | string {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match?.[1]) return "PROJECT.md starts with frontmatter: --- summary: ... status: active ---";
  const fields = Object.fromEntries(
    match[1].split(/\r?\n/).flatMap((line) => {
      const field = /^([a-zA-Z]+):\s*(.*?)\s*(?:#.*)?$/.exec(line);
      return field?.[1] ? [[field[1], (field[2] ?? "").replace(/^["']|["']$/g, "")]] : [];
    }),
  ) as Record<string, string>;
  if (!fields.summary) return "PROJECT.md's frontmatter needs a one-line summary";
  if (!(STATUSES as readonly string[]).includes(fields.status ?? "")) {
    return `PROJECT.md's frontmatter needs status: ${STATUSES.join(", ")}`;
  }
  return { summary: fields.summary, status: fields.status as ProjectFront["status"] };
}

/** The checks a write must pass: README is kiln's, PROJECT.md keeps its frontmatter, text stays text. */
export function checkWrite(path: string, bytes: Uint8Array): void {
  if (path === README) throw new DriveError("README.md is kiln's; write your notes in another file");
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new DriveError(`files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
  const segments = path.split("/");
  if (segments[0] === PROJECTS && segments.length === 2) {
    throw new DriveError(`files in a project go inside its folder: ${PROJECTS}/<slug>/...`);
  }
  if (segments[0] === PROJECTS && segments.length === 3 && segments[2] === PROJECT_FILE) {
    const front = projectFront(new TextDecoder().decode(bytes));
    if (typeof front === "string") throw new DriveError(front);
  }
}

export async function writeFile(store: DriveStore, raw: string, bytes: Uint8Array): Promise<string> {
  const path = drivePath(raw);
  checkWrite(path, bytes);
  await store.write(path, bytes, contentTypeOf(path));
  return path;
}

export async function readText(
  store: DriveStore,
  raw: string,
): Promise<{ path: string; text?: string; contentType: string; size: number }> {
  const path = drivePath(raw);
  const file = await store.read(path);
  if (!file) throw new DriveError(`no file at ${path}`);
  if (!isText(path)) return { path, contentType: file.contentType, size: file.bytes.byteLength };
  const text = new TextDecoder().decode(file.bytes);
  return {
    path,
    contentType: file.contentType,
    size: file.bytes.byteLength,
    text:
      text.length > MAX_TEXT_READ
        ? `${text.slice(0, MAX_TEXT_READ)}\n[cut at ${MAX_TEXT_READ} characters]`
        : text,
  };
}

export async function moveFile(store: DriveStore, rawFrom: string, rawTo: string): Promise<string> {
  const from = drivePath(rawFrom);
  const to = drivePath(rawTo);
  if (from === README) throw new DriveError("README.md is kiln's");
  const file = await store.read(from);
  if (!file) throw new DriveError(`no file at ${from}`);
  checkWrite(to, file.bytes);
  await store.write(to, file.bytes, contentTypeOf(to));
  await store.remove(from);
  return to;
}

export async function removeFile(store: DriveStore, raw: string): Promise<string> {
  const path = drivePath(raw);
  if (path === README) throw new DriveError("README.md is kiln's");
  await store.remove(path);
  return path;
}

export interface ProjectSummary extends ProjectFront {
  readonly slug: string;
  readonly files: number;
  readonly updatedAt: string;
}

/** Every project folder, with its PROJECT.md's summary and status; a folder without one says so. */
export async function projectIndex(store: DriveStore): Promise<ProjectSummary[]> {
  const entries = await store.list(`${PROJECTS}/`);
  const bySlug = new Map<string, DriveEntry[]>();
  for (const entry of entries) {
    const slug = entry.path.split("/")[1];
    if (slug) bySlug.set(slug, [...(bySlug.get(slug) ?? []), entry]);
  }
  const projects: ProjectSummary[] = [];
  for (const [slug, files] of bySlug) {
    const file = await store.read(`${PROJECTS}/${slug}/${PROJECT_FILE}`);
    const front = file ? projectFront(new TextDecoder().decode(file.bytes)) : "PROJECT.md is missing";
    const updatedAt =
      files
        .map((f) => f.updatedAt)
        .sort()
        .at(-1) ?? "";
    projects.push(
      typeof front === "string"
        ? { slug, summary: `(${front})`, status: "active", files: files.length, updatedAt }
        : { slug, ...front, files: files.length, updatedAt },
    );
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** What the agent is told about its drive each turn: the projects, newest activity first. */
export function indexText(projects: readonly ProjectSummary[]): string {
  const lines = [
    "[your drive: the project index, kept by kiln]",
    projects.length === 0
      ? "No projects yet. When an initiative starts, create projects/<slug>/PROJECT.md (see README.md in your drive)."
      : "Projects, most recently touched first. Read a project's PROJECT.md before you work on it, and keep it current.",
  ];
  for (const p of projects) {
    lines.push(
      `- ${p.slug} (${p.status}, ${p.files} files, updated ${p.updatedAt.slice(0, 10)}): ${p.summary}`,
    );
  }
  return lines.join("\n");
}

export interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** Case-insensitive search through the text files under a folder. */
export async function searchDrive(
  store: DriveStore,
  query: string,
  rawFolder?: string,
): Promise<SearchHit[]> {
  const needle = query.trim().toLowerCase();
  if (!needle) throw new DriveError("search for something");
  const entries = (await store.list(driveFolder(rawFolder)))
    .filter((e) => isText(e.path))
    .slice(0, MAX_SEARCH_FILES);
  const hits: SearchHit[] = [];
  for (const entry of entries) {
    if (entry.path.toLowerCase().includes(needle)) hits.push({ path: entry.path, line: 0, text: "(path)" });
    const file = await store.read(entry.path);
    if (!file) continue;
    new TextDecoder()
      .decode(file.bytes)
      .split("\n")
      .forEach((text, index) => {
        if (hits.length < MAX_SEARCH_HITS && text.toLowerCase().includes(needle)) {
          hits.push({ path: entry.path, line: index + 1, text: text.trim().slice(0, 300) });
        }
      });
    if (hits.length >= MAX_SEARCH_HITS) break;
  }
  return hits;
}

/** A drive kept in memory, for tests and local development. */
export function memoryDrive(now: () => string = () => new Date().toISOString()): DriveStore {
  const files = new Map<string, { bytes: Uint8Array; contentType: string; updatedAt: string }>();
  return {
    async list(prefix) {
      return [...files.entries()]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, f]) => ({ path, size: f.bytes.byteLength, updatedAt: f.updatedAt }))
        .sort((a, b) => a.path.localeCompare(b.path));
    },
    async read(path) {
      const f = files.get(path);
      return f ? { bytes: f.bytes, contentType: f.contentType } : null;
    },
    async write(path, bytes, contentType) {
      files.set(path, { bytes, contentType, updatedAt: now() });
    },
    async remove(path) {
      files.delete(path);
    },
  };
}
