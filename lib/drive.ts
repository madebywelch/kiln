// The agent's drive: a folder of files it organizes however it likes. Two
// files are there from the start and can't be deleted, moved, or renamed:
// AGENTS.md, its conventions for itself, which it sees every turn, and
// INDEX.md, its map of the drive, which it reads when it needs to. It writes
// both; everything else is an empty canvas. Only AGENTS.md is shown each turn
// because it changes rarely, so it doesn't break the prompt cache.

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

/** The files every drive has, with what they start as. The agent edits them; nobody removes them. */
export const DEFAULT_FILES: Readonly<Record<string, string>> = {
  "AGENTS.md":
    "# How I work\n\nConventions I keep for this drive and for the people I work with. Add to it when someone tells me how they want things done.\n\n- INDEX.md is my map of this drive: what is where, one line per file or folder. I read it when I need to find something and update it when I add, move, or remove things.\n",
  "INDEX.md": "# Index\n\nWhat is in this drive and where, one line per file or folder.\n",
};
/** The default file the agent sees every turn. */
export const TURN_FILE = "AGENTS.md";
const isDefault = (path: string) => path in DEFAULT_FILES;
/** How much of AGENTS.md the agent sees every turn. */
const MAX_TURN_CHARS = 6_000;
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

/** Writes any default file that is missing. */
export async function ensureDefaults(store: DriveStore): Promise<void> {
  for (const [path, text] of Object.entries(DEFAULT_FILES)) {
    if (!(await store.read(path)))
      await store.write(path, new TextEncoder().encode(text), contentTypeOf(path));
  }
}

function checkSize(bytes: Uint8Array): void {
  if (bytes.byteLength > MAX_FILE_BYTES)
    throw new DriveError(`files are limited to ${MAX_FILE_BYTES / 1024 / 1024} MB`);
}

const permanent = (path: string) =>
  new DriveError(`${path} is one of the drive's permanent files; edit it instead`);

export async function writeFile(store: DriveStore, raw: string, bytes: Uint8Array): Promise<string> {
  const path = drivePath(raw);
  checkSize(bytes);
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
  if (isDefault(from)) throw permanent(from);
  const file = await store.read(from);
  if (!file) throw new DriveError(`no file at ${from}`);
  await store.write(to, file.bytes, contentTypeOf(to));
  await store.remove(from);
  return to;
}

export async function removeFile(store: DriveStore, raw: string): Promise<string> {
  const path = drivePath(raw);
  if (isDefault(path)) throw permanent(path);
  await store.remove(path);
  return path;
}

/** What the agent sees of its drive every turn: AGENTS.md. */
export async function turnContext(store: DriveStore): Promise<string> {
  const file = await store.read(TURN_FILE);
  const text = file ? new TextDecoder().decode(file.bytes).trim() : "";
  const shown =
    text.length > MAX_TURN_CHARS
      ? `${text.slice(0, MAX_TURN_CHARS)}\n[cut: ${TURN_FILE} is too long; tighten it]`
      : text;
  return `[your drive's ${TURN_FILE}, from kiln]\n${shown}`;
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
